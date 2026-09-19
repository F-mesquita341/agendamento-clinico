'use strict';

/**
 * Teste de carga da Seção 4.5: cem requisições simultâneas pelo mesmo horário.
 *
 * Critério do projeto: "zero conflitos detectados no teste de carga simples com
 * cem requisições simultâneas para o mesmo horário". Conflito, aqui, é
 * agendamento duplicado — ver o vocabulário em ./avaliacao.js.
 *
 * Três fases, porque são três perguntas:
 *
 *   A — o SISTEMA aguenta? 100 pacientes distintos fazem POST /consultas ao
 *       mesmo tempo, pelo caminho inteiro: token, perfil, checagem prévia,
 *       transação. As recusas são separadas pela camada que as decidiu.
 *
 *   B — o BANCO garante sozinho? 100 chamadas simultâneas direto ao
 *       adaptador, sem a checagem prévia. Toda recusa é do banco, e a sequência
 *       de ids confirma que foi do UPDATE condicional, e não do índice único.
 *
 *   C — a VERSÃO cumpre o papel que só ela cumpre? O horário é reservado e
 *       cancelado — volta a disponível, na versão 2 — e 100 pedidos chegam com
 *       a versão 0, lida antes disso. O status confere, então só a condição de
 *       versão pode recusá-los. Nas fases A e B, versão e status falham juntos
 *       para todo perdedor, e o experimento não separa uma do outro ali.
 *
 * Uso:
 *   npm run carga               10 rodadas por fase, relatório gravado em
 *                               docs/resultados/concorrencia/
 *   npm run carga -- --ensaio   as mesmas rodadas, sem gravar relatório
 *
 * Roda SEMPRE contra o banco de teste, que é apagado no início — o mesmo que a
 * suíte faz. Pacientes distintos em cada requisição: com o mesmo paciente,
 * parte das recusas viria da regra de agenda sobreposta.
 */

// Antes de qualquer require: config.js lê o ambiente ao ser carregado. O modo
// de teste é o que garante o banco de teste, e aborta se ele coincidir com o
// de desenvolvimento. O pool de 10 é o mesmo de produção. Teste de verdade, e
// não `??=`: uma variável definida e vazia também conta como ausente em
// config.js, e o pool cairia para o padrão de teste sem ninguém perceber.
process.env.NODE_ENV = 'test';
if (!process.env.POOL_MAXIMO) process.env.POOL_MAXIMO = '10';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const config = require('../../src/config');
const { criarApp } = require('../../src/interfaces/http/app');
const { pool, consultar, encerrar, transporte } = require('../../src/infra/db/pool');
const { RepositorioDeHorariosPg } = require('../../src/infra/db/RepositorioDeHorariosPg');
const { RepositorioDeConsultasPg } = require('../../src/infra/db/RepositorioDeConsultasPg');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../../src/domain/Paciente');
const { FUSO_DA_CLINICA } = require('../../src/interfaces/http/esquemas');
const { semear } = require('../helpers/semente');
const { verificadorFalso, tokenDe } = require('../helpers/verificadorFalso');
const {
  percentil,
  resumir,
  avaliarRodadaHttp,
  avaliarRodadaAdaptador,
  avaliarRodadaDesatualizada,
} = require('./avaliacao');

const N = 100;
const RODADAS = 10;
const ENSAIO = process.argv.includes('--ensaio');
const PRAZO_POR_REQUISICAO_MS = 60_000;
const PRAZO_TOTAL_MS = 15 * 60_000;
const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;

const RAIZ = path.join(__dirname, '..', '..');
const PASTA_RESULTADOS = path.join(RAIZ, 'docs', 'resultados', 'concorrencia');

// Vigia: se algo travar — conexão pendurada, consulta sem resposta —, o
// processo termina com erro em vez de segurar a integração contínua por horas.
// `unref` para não ser ele a manter o processo vivo quando tudo corre bem.
setTimeout(() => {
  console.error(`\nO experimento passou de ${PRAZO_TOTAL_MS / 60_000} minutos e foi interrompido.`);
  process.exit(1);
}, PRAZO_TOTAL_MS).unref();

/**
 * Conta, POR HORÁRIO, quantos pedidos chegaram ao UPDATE e quantos perderam lá.
 *
 * Por horário, e não num contador global zerado a cada rodada: um pedido que
 * estourou o prazo no cliente continua rodando no servidor e, com contador
 * global, cairia na conta da rodada seguinte.
 *
 * Subclasse usada só aqui: nenhum comportamento de produção muda. A rota a
 * recebe por injeção, pelo mesmo caminho que os testes usam para o verificador
 * de token.
 */
class HorariosMedidos extends RepositorioDeHorariosPg {
  constructor() {
    super();
    this.porHorario = new Map();
  }

  contagem(horarioId) {
    return this.porHorario.get(Number(horarioId)) ?? { tentativas: 0, perdidas: 0 };
  }

  async reservarEAgendar(dados) {
    const conta = this.contagem(dados.horarioId);
    this.porHorario.set(Number(dados.horarioId), conta);
    conta.tentativas += 1;
    const consulta = await super.reservarEAgendar(dados);
    if (!consulta) conta.perdidas += 1;
    return consulta;
  }
}

// --- Ambiente ---------------------------------------------------------------

function git(comando) {
  try {
    return execSync(`git ${comando}`, { cwd: RAIZ, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Commit e estado da árvore, lidos no INÍCIO: é o código carregado agora que
 * será medido. Relatórios de execuções anteriores, ainda não commitados, não
 * contam como alteração — não são código.
 */
function estadoDoRepositorio() {
  const commit = git('rev-parse --short HEAD') ?? 'desconhecido';
  const porcelana = git('status --porcelain');
  const alteracoes =
    porcelana === null
      ? null
      : porcelana
          .split('\n')
          .filter(Boolean)
          .filter((linha) => !linha.slice(3).startsWith('docs/resultados/'));
  return { commit, arvoreLimpa: alteracoes !== null && alteracoes.length === 0 };
}

/**
 * Descreve o banco a partir da URL — só o provedor e a região, nunca a string
 * de conexão. O relatório não pode afirmar "Neon em São Paulo" de uma execução
 * que rodou contra um PostgreSQL local.
 */
function descreverBanco(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { descricao: 'PostgreSQL (endereço não reconhecido)', local: false, neon: false };
  }
  if (['localhost', '127.0.0.1', '::1'].includes(host)) {
    return { descricao: 'PostgreSQL local', local: true, neon: false };
  }
  if (host.endsWith('.neon.tech')) {
    const regiao = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host)?.[1] ?? 'região não identificada';
    const viaPooler = host.includes('-pooler') ? ', via pooler' : ', conexão direta';
    return { descricao: `Neon (${regiao}${viaPooler})`, local: false, neon: true };
  }
  return { descricao: 'PostgreSQL remoto', local: false, neon: false };
}

/** Mediana de dez idas simples ao banco: a escala de todos os outros números. */
async function medirIdaAoBanco() {
  const amostras = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    await consultar('SELECT 1');
    amostras.push(performance.now() - t0);
  }
  return percentil(amostras, 50);
}

// --- Preparação -------------------------------------------------------------

async function prepararBanco() {
  const dados = await semear();
  const profissionalId = dados.profissionais.jose;

  const { rows: precos } = await consultar(
    'SELECT valor_consulta_centavos FROM profissional WHERE id = $1',
    [profissionalId]
  );

  // Cem pacientes com consentimento, num INSERT só.
  const { rows } = await consultar(
    `INSERT INTO paciente (firebase_uid, nome, email, consentimento_versao, consentimento_em)
     SELECT 'uid-carga-' || lpad(i::text, 3, '0'),
            'Paciente de Carga ' || i,
            'carga' || lpad(i::text, 3, '0') || '@example.com',
            $1, now()
       FROM generate_series(1, $2) AS i
     RETURNING id, firebase_uid, email`,
    [VERSAO_TERMO_CONSENTIMENTO, N]
  );

  const pacientes = rows.map((linha) => ({
    id: Number(linha.id),
    token: tokenDe(linha.firebase_uid, linha.email),
  }));

  const { rows: seq } = await consultar(
    "SELECT pg_get_serial_sequence('consulta', 'id') AS nome"
  );

  return {
    profissionalId,
    preco: precos[0].valor_consulta_centavos,
    pacientes,
    sequencia: seq[0].nome,
  };
}

/**
 * Quantos números a sequência de ids de `consulta` já entregou.
 *
 * Toda tentativa de INSERT consome um, mesmo quando a transação é desfeita —
 * sequências não voltam atrás. É o que separa a recusa do UPDATE da recusa do
 * índice único; ver o cabeçalho de ./avaliacao.js.
 */
async function insercoesConsumidas(sequencia) {
  const { rows } = await consultar(`SELECT last_value, is_called FROM ${sequencia}`);
  return Number(rows[0].last_value) - (rows[0].is_called ? 0 : 1);
}

/**
 * Horários em instantes que nunca colidem: um dia por rodada — a fase A às
 * 0h do deslocamento, a B às 4h, a C às 8h —, a partir de 30 dias no futuro,
 * longe dos horários do seed e sem sobreposição na agenda de nenhum paciente.
 */
function inicioDoHorario(base, rodada, fase) {
  const deslocamento = { A: 0, B: 4, C: 8 }[fase] * HORA_MS;
  return new Date(base.getTime() + rodada * DIA_MS + deslocamento);
}

async function criarHorario(profissionalId, inicio) {
  const { rows } = await consultar(
    `INSERT INTO horario (profissional_id, inicio, fim)
     VALUES ($1, $2::timestamptz, $2::timestamptz + interval '30 minutes')
     RETURNING id`,
    [profissionalId, inicio]
  );
  return Number(rows[0].id);
}

async function estadoDoHorario(horarioId) {
  const { rows } = await consultar(
    `SELECT h.status, h.versao,
            (SELECT count(*)::int FROM consulta c
              WHERE c.horario_id = h.id AND c.status <> 'cancelada') AS consultas_ativas,
            (SELECT min(c.valor_centavos) FROM consulta c
              WHERE c.horario_id = h.id AND c.status <> 'cancelada') AS valor_centavos,
            (SELECT count(*)::int FROM auditoria a
              WHERE a.acao = 'consulta.criada'
                AND (a.detalhe->>'horarioId')::bigint = h.id) AS auditorias
       FROM horario h
      WHERE h.id = $1`,
    [horarioId]
  );
  const linha = rows[0];
  return {
    status: linha.status,
    versao: linha.versao,
    consultasAtivas: linha.consultas_ativas,
    valorCentavos: linha.valor_centavos,
    auditorias: linha.auditorias,
  };
}

// --- Rajada HTTP ------------------------------------------------------------

async function pedir(url, token, corpo) {
  const disparo = performance.now();
  try {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: corpo,
      signal: AbortSignal.timeout(PRAZO_POR_REQUISICAO_MS),
    });
    const json = await resposta.json().catch(() => null);
    return {
      status: resposta.status,
      codigo: json?.erro?.codigo ?? null,
      ms: performance.now() - disparo,
    };
  } catch (erro) {
    // Sem resposta: timeout ou conexão derrubada. Entra como resposta
    // inesperada e reprova a rodada, em vez de derrubar o experimento inteiro.
    return { status: 0, codigo: `SEM_RESPOSTA (${erro.name})`, ms: performance.now() - disparo };
  }
}

/**
 * Cem POST /consultas simultâneos, todos com a mesma versão.
 *
 * Mede o instante em que cada requisição CHEGA ao servidor — a medida honesta
 * de simultaneidade no lado HTTP. No banco, a simultaneidade é limitada pelo
 * pool; isso é declarado no relatório.
 */
async function rajadaHttp({ url, servidor, pacientes }, horarioId, versao) {
  const corpo = JSON.stringify({ horarioId, versao });
  const chegadas = [];
  const aoChegar = () => chegadas.push(performance.now());
  servidor.on('request', aoChegar);

  const inicio = performance.now();
  try {
    const respostas = await Promise.all(
      pacientes.map((p) => pedir(`${url}/consultas`, p.token, corpo))
    );
    return {
      respostas,
      duracaoMs: performance.now() - inicio,
      janelaDeChegadaMs: chegadas.length ? Math.max(...chegadas) - Math.min(...chegadas) : null,
    };
  } finally {
    servidor.off('request', aoChegar);
  }
}

// --- Fase A: o sistema, via HTTP --------------------------------------------

async function rodadaHttp(numero, contexto) {
  const { medidos, base, profissionalId, preco, sequencia } = contexto;

  const horarioId = await criarHorario(profissionalId, inicioDoHorario(base, numero, 'A'));
  const antes = await insercoesConsumidas(sequencia);
  const { respostas, duracaoMs, janelaDeChegadaMs } = await rajadaHttp(contexto, horarioId, 0);
  const insercoesTentadas = (await insercoesConsumidas(sequencia)) - antes;

  const banco = { ...(await estadoDoHorario(horarioId)), insercoesTentadas };
  const avaliacao = avaliarRodadaHttp({ n: N, respostas, banco, precoEsperado: preco });

  const { tentativas, perdidas } = medidos.contagem(horarioId);
  const recusas409 = respostas.filter((r) => r.status === 409).length;
  const vencedor = respostas.find((r) => r.status === 201);

  return {
    rodada: numero,
    horarioId,
    criadas: respostas.filter((r) => r.status === 201).length,
    recusas: recusas409,
    outras: respostas.filter((r) => r.status !== 201 && r.status !== 409).length,
    recusasNoBanco: perdidas,
    recusasNaChecagemPrevia: recusas409 - perdidas,
    chegaramAoUpdate: tentativas,
    janelaDeChegadaMs,
    duracaoMs,
    latencia: resumir(respostas.map((r) => r.ms)),
    vencedorMs: vencedor?.ms ?? null,
    latenciasMs: respostas.map((r) => Math.round(r.ms * 10) / 10),
    banco,
    avaliacao,
  };
}

// --- Fase B: o banco, direto no adaptador -----------------------------------

async function rodadaAdaptador(numero, contexto) {
  const { base, profissionalId, pacientes, sequencia } = contexto;

  const horarioId = await criarHorario(profissionalId, inicioDoHorario(base, numero, 'B'));
  const repositorio = new RepositorioDeHorariosPg();
  const reservaExpiraEm = new Date(Date.now() + config.RESERVA_MINUTOS * 60_000);

  const antes = await insercoesConsumidas(sequencia);
  const inicio = performance.now();
  const resultados = await Promise.all(
    pacientes.map(async (p) => {
      const t0 = performance.now();
      try {
        const consulta = await repositorio.reservarEAgendar({
          horarioId,
          versao: 0,
          pacienteId: p.id,
          reservaExpiraEm,
        });
        return { tipo: consulta ? 'consulta' : 'nulo', ms: performance.now() - t0 };
      } catch (erro) {
        return { tipo: 'erro', erro: erro.message, ms: performance.now() - t0 };
      }
    })
  );
  const duracao = performance.now() - inicio;
  const insercoesTentadas = (await insercoesConsumidas(sequencia)) - antes;

  const banco = { ...(await estadoDoHorario(horarioId)), insercoesTentadas };
  const avaliacao = avaliarRodadaAdaptador({ n: N, resultados, banco });
  const vencedor = resultados.find((r) => r.tipo === 'consulta');

  return {
    rodada: numero,
    horarioId,
    consultas: resultados.filter((r) => r.tipo === 'consulta').length,
    recusasNoBanco: resultados.filter((r) => r.tipo === 'nulo').length,
    excecoes: resultados.filter((r) => r.tipo === 'erro').length,
    duracaoMs: duracao,
    latencia: resumir(resultados.map((r) => r.ms)),
    vencedorMs: vencedor?.ms ?? null,
    latenciasMs: resultados.map((r) => Math.round(r.ms * 10) / 10),
    banco,
    avaliacao,
  };
}

// --- Fase C: leitura desatualizada, via HTTP --------------------------------

async function rodadaDesatualizada(numero, contexto) {
  const { url, medidos, base, profissionalId, pacientes, sequencia } = contexto;

  const horarioId = await criarHorario(profissionalId, inicioDoHorario(base, numero, 'C'));

  // Alguém reserva e cancela pelo caminho real: o horário volta a disponível,
  // agora na versão 2. Os cem pedidos a seguir leram a grade antes disso.
  const reserva = await new RepositorioDeHorariosPg().reservarEAgendar({
    horarioId,
    versao: 0,
    pacienteId: pacientes[0].id,
    reservaExpiraEm: new Date(Date.now() + config.RESERVA_MINUTOS * 60_000),
  });
  await new RepositorioDeConsultasPg().cancelar(reserva.id);

  const antes = await insercoesConsumidas(sequencia);
  const { respostas, duracaoMs, janelaDeChegadaMs } = await rajadaHttp(contexto, horarioId, 0);
  const insercoesTentadas = (await insercoesConsumidas(sequencia)) - antes;
  const banco = { ...(await estadoDoHorario(horarioId)), insercoesTentadas };

  // Quem leu a grade depois do cancelamento tem a versão 2, e precisa conseguir.
  const respostaAtualizada = await pedir(
    `${url}/consultas`,
    pacientes[1].token,
    JSON.stringify({ horarioId, versao: 2 })
  );

  const avaliacao = avaliarRodadaDesatualizada({ n: N, respostas, banco, respostaAtualizada });
  const { tentativas, perdidas } = medidos.contagem(horarioId);

  return {
    rodada: numero,
    horarioId,
    aceitas: respostas.filter((r) => r.status === 201).length,
    recusas: respostas.filter((r) => r.status === 409).length,
    outras: respostas.filter((r) => r.status !== 201 && r.status !== 409).length,
    // O pedido atualizado também passa pelo contador; ele não é recusa.
    recusasNoBanco: perdidas,
    chegaramAoUpdate: tentativas - 1,
    janelaDeChegadaMs,
    duracaoMs,
    latencia: resumir(respostas.map((r) => r.ms)),
    latenciasMs: respostas.map((r) => Math.round(r.ms * 10) / 10),
    respostaAtualizada: respostaAtualizada.status,
    banco,
    avaliacao,
  };
}

// --- Relatório --------------------------------------------------------------

function agoraNaClinica() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: FUSO_DA_CLINICA,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return {
    arquivo: `${partes.year}-${partes.month}-${partes.day}-${partes.hour}${partes.minute}${partes.second}`,
    legivel: `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`,
  };
}

const ms = (valor) => (valor === null || valor === undefined ? '—' : Math.round(valor).toString());
const soma = (rodadas, campo) => rodadas.reduce((total, r) => total + r[campo], 0);
const aprovadas = (rodadas) => rodadas.filter((r) => r.avaliacao.aprovada).length;
const marca = (r) => (r.avaliacao.aprovada ? '✓' : '✗');

function montarMarkdown(m, faseA, faseB, faseC) {
  const todas = [...faseA, ...faseB, ...faseC];
  const conflitos = todas.reduce((total, r) => total + r.avaliacao.conflitos, 0);
  const criterio = conflitos === 0;

  const todasA = faseA.flatMap((r) => r.latenciasMs);
  const geralA = resumir(todasA);
  const noBanco = soma(faseA, 'recusasNoBanco');
  const naChecagem = soma(faseA, 'recusasNaChecagemPrevia');
  const pct = (parte) => {
    const total = noBanco + naChecagem;
    return total ? ((100 * parte) / total).toFixed(1) : '0.0';
  };

  const linhasA = faseA.map(
    (r) =>
      `| ${r.rodada} | ${r.criadas} | ${r.recusas} | ${r.outras} | ${r.recusasNaChecagemPrevia} | ` +
      `${r.recusasNoBanco} | ${r.banco.insercoesTentadas} | ${r.banco.consultasAtivas} | ` +
      `${ms(r.janelaDeChegadaMs)} | ${ms(r.duracaoMs)} | ${ms(r.latencia.p50)} | ` +
      `${ms(r.latencia.p95)} | ${ms(r.vencedorMs)} | ${marca(r)} |`
  );
  const linhasB = faseB.map(
    (r) =>
      `| ${r.rodada} | ${r.consultas} | ${r.recusasNoBanco} | ${r.banco.insercoesTentadas} | ` +
      `${r.excecoes} | ${r.banco.consultasAtivas} | ${ms(r.duracaoMs)} | ${ms(r.latencia.p50)} | ` +
      `${ms(r.latencia.p95)} | ${ms(r.vencedorMs)} | ${marca(r)} |`
  );
  const linhasC = faseC.map(
    (r) =>
      `| ${r.rodada} | ${r.aceitas} | ${r.recusas} | ${r.outras} | ${r.recusasNoBanco} | ` +
      `${r.banco.insercoesTentadas} | ${r.banco.versao} | ${r.respostaAtualizada} | ` +
      `${ms(r.janelaDeChegadaMs)} | ${ms(r.duracaoMs)} | ${ms(r.latencia.p50)} | ${marca(r)} |`
  );

  const anomalias = todas
    .filter((r) => !r.avaliacao.aprovada)
    .map((r) => `- Rodada ${r.rodada}: ${r.avaliacao.falhas.join('; ')}`);

  const ambienteDeRede = m.banco.local
    ? 'PostgreSQL na própria máquina: as idas ao banco são quase instantâneas, e os números absolutos não representam uma instalação em rede.'
    : `Máquina local contra ${m.banco.descricao}: com ${ms(m.idaAoBancoMs)} ms por ida ao banco, a rede domina os números absolutos, que não devem ser lidos como desempenho em produção.`;

  return `# Teste de concorrência — ${m.data}

## Resultado

- **Critério da Seção 4.5 — zero conflitos: ${criterio ? 'ATENDIDO' : 'NÃO ATENDIDO'}.**
  ${conflitos} agendamento(s) duplicado(s) em ${todas.length} rodadas de ${N} pedidos simultâneos.
- **Rodadas sem nenhuma anomalia:** fase A ${aprovadas(faseA)}/${RODADAS}, fase B
  ${aprovadas(faseB)}/${RODADAS}, fase C ${aprovadas(faseC)}/${RODADAS}. Anomalia é qualquer
  desvio do esperado — uma resposta inesperada, uma recusa decidida pelo índice
  em vez do UPDATE — e não se confunde com conflito.

## Vocabulário

- **Conflito** — agendamento duplicado: mais de uma consulta ativa no mesmo
  horário. É o que o critério exige que seja zero.
- **Recusa** — resposta \`409 HORARIO_INDISPONIVEL\` a quem perdeu a disputa. É o
  resultado correto. O HTTP chama o 409 de *Conflict*, mas recusa não é
  conflito — conflito seria ela *não* acontecer.

## As defesas, e o que cada fase isola

O agendamento tem duas defesas no banco: o **UPDATE condicional**
(\`WHERE id = $1 AND versao = $2 AND status = 'disponivel'\`) e o **índice único
parcial** \`consulta_horario_ativo\`, que recusa uma segunda consulta ativa no
mesmo horário.

- **Fase A** — o sistema, pelo caminho completo da API. Mostra que não há
  duplicidade na prática.
- **Fase B** — direto no adaptador, sem a checagem prévia do caso de uso. Toda
  recusa é do banco. A coluna *inserções* mostra que só o vencedor chegou a
  tentar o INSERT: nenhuma recusa foi decidida pelo índice.
- **Fase C** — leitura desatualizada. Nas fases A e B, versão e status falham
  **juntos** para todo perdedor, e o experimento não separa um do outro ali.
  Aqui o horário foi reservado e cancelado — voltou a disponível, na versão 2 —,
  e os cem pedidos chegam com a versão 0. O status confere; **só a condição de
  versão pode recusá-los**. É o papel próprio do lock otimista.

**Recusas no banco** conta todo pedido que o adaptador recusou, venha a recusa
do UPDATE ou do índice. Quem decide qual foi é a coluna **inserções**: cada
tentativa de INSERT consome um número da sequência de ids, mesmo quando é
desfeita. Uma inserção por rodada nas fases A e B, e nenhuma na C, significa que
todas as recusas foram do UPDATE condicional.

Que o experimento detecta a ausência de cada defesa foi verificado à parte,
removendo-as do código: ver o diário do projeto, entrada de 19/09/2026.

## Ambiente

| | |
|---|---|
| Data | ${m.data} (horário de Fortaleza) |
| Commit | \`${m.commit}\`${m.arvoreLimpa ? '' : ' — **com alterações não commitadas**'} |
| Node.js | ${m.node} |
| Sistema | ${m.sistema} |
| Banco | PostgreSQL ${m.postgres}, ${m.banco.descricao}, banco de teste |
| Isolamento | ${m.isolamento} |
| Ida ao banco | ${ms(m.idaAoBancoMs)} ms (mediana de 10 \`SELECT 1\`) |
| Transporte | ${m.transporte} |
| Pool de conexões | ${m.pool} — no máximo ${m.pool} transações simultâneas no banco |
| Pedidos por rodada | ${N}, cada um de um paciente diferente |
| Rodadas por fase | ${RODADAS}, precedidas de um aquecimento não contabilizado |

## Fase A — o sistema, via HTTP

| Rodada | 201 | 409 | outras | recusas na checagem | recusas no banco | inserções | consultas no horário | chegada (ms) | duração (ms) | p50 | p95 | vencedor (ms) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${linhasA.join('\n')}

- **Chegada** é o intervalo entre a primeira e a última requisição a chegar ao
  servidor HTTP. No banco, o pool limita a ${m.pool} transações simultâneas; os
  demais pedidos esperam por uma conexão.
- Recusas: ${pct(naChecagem)}% decididas pela checagem prévia do caso de uso,
  ${pct(noBanco)}% no banco. Com uma inserção por rodada, as do banco foram todas do
  UPDATE condicional — onde versão e status, juntos, já não conferiam. A divisão
  entre checagem e banco depende da forma da carga e do tempo de uma ida ao
  banco; não é propriedade fixa do sistema.
- Latência das ${todasA.length} requisições: p50 ${ms(geralA.p50)} ms, p95 ${ms(geralA.p95)} ms,
  máximo ${ms(geralA.maximo)} ms. Não são ${todasA.length} amostras independentes: a
  latência é quase só função da posição de cada pedido na fila.

## Fase B — o banco, direto no adaptador

| Rodada | consultas criadas | recusas no banco | inserções | exceções | consultas no horário | duração (ms) | p50 | p95 | vencedor (ms) | |
|---|---|---|---|---|---|---|---|---|---|---|
${linhasB.join('\n')}

## Fase C — leitura desatualizada, via HTTP

| Rodada | aceitos | 409 | outras | recusas no banco | inserções | versão após | pedido com versão atual | chegada (ms) | duração (ms) | p50 | |
|---|---|---|---|---|---|---|---|---|---|---|---|
${linhasC.join('\n')}

A checagem prévia do caso de uso olha só o status, que confere; por isso todos
os pedidos desatualizados chegam ao UPDATE, e quem os recusa é a condição de
versão. Depois da rajada, um pedido com a versão atual (2) é aceito — prova de
que a recusa era pela desatualização.
${anomalias.length ? `\n## Anomalias\n\n${anomalias.join('\n')}\n` : ''}
## Limitações

- **Concorrência no banco limitada pelo pool:** ${m.pool} transações simultâneas, num
  único processo. Várias instâncias da API não foram testadas.
- **Rodadas não são amostras independentes:** repetem quase o mesmo
  escalonamento. Mesmo tratadas como independentes, zero falhas em ${RODADAS}
  rodadas deixam o limite superior de 95% da taxa de falha por rodada em cerca
  de ${Math.round(100 * (1 - 0.05 ** (1 / RODADAS)))}%. A garantia vem do mecanismo; o teste a corrobora.
- **Isolamento:** o comportamento depende de ${m.isolamento}. Em REPEATABLE READ,
  os perdedores receberiam erro de serialização em vez de uma recusa limpa.
- **Ambiente:** ${ambienteDeRede}
- Cliente e servidor rodam no mesmo processo; as latências incluem o trabalho
  do próprio gerador de carga.
- O token é verificado por um dublê com o mesmo contrato do Firebase; o custo de
  verificar a assinatura do JWT fica de fora.
- Um único horário disputado por rodada — o pior caso de contenção, e não uma
  carga típica de clínica.
`;
}

// --- Execução ---------------------------------------------------------------

async function executarFases(contexto) {
  const fases = { A: [], B: [], C: [] };
  const linha = (fase, i, r, texto) =>
    console.log(
      `${fase} ${String(i).padStart(2)}/${RODADAS}  ${texto}  ${ms(r.duracaoMs)} ms  ` +
        (r.avaliacao.aprovada ? '✓' : `✗ ${r.avaliacao.falhas.join('; ')}`)
    );

  for (let i = 1; i <= RODADAS; i += 1) {
    const r = await rodadaHttp(i, contexto);
    fases.A.push(r);
    linha('A', i, r,
      `${r.criadas}×201 ${r.recusas}×409 (checagem ${r.recusasNaChecagemPrevia}, banco ${r.recusasNoBanco}) ` +
        `inserções ${r.banco.insercoesTentadas}  conflitos ${r.avaliacao.conflitos}`);
  }
  for (let i = 1; i <= RODADAS; i += 1) {
    const r = await rodadaAdaptador(i, contexto);
    fases.B.push(r);
    linha('B', i, r,
      `${r.consultas} consulta, ${r.recusasNoBanco} recusas no banco, inserções ${r.banco.insercoesTentadas}  ` +
        `conflitos ${r.avaliacao.conflitos}`);
  }
  for (let i = 1; i <= RODADAS; i += 1) {
    const r = await rodadaDesatualizada(i, contexto);
    fases.C.push(r);
    linha('C', i, r,
      `${r.aceitas} aceitos ${r.recusas}×409 (banco ${r.recusasNoBanco}) versão ${r.banco.versao}, ` +
        `pedido atual → ${r.respostaAtualizada}`);
  }
  return fases;
}

async function principal() {
  // Lidos antes de qualquer outra coisa: é este código que vai ser medido.
  const repositorio = estadoDoRepositorio();
  const banco = descreverBanco(config.urlDoBanco);
  const tamanhoDoPool = pool.options?.max ?? config.POOL_MAXIMO;

  console.log(
    `\nTeste de concorrência: ${RODADAS} rodadas × ${N} pedidos, três fases, pool de ${tamanhoDoPool}, ` +
      `${banco.descricao}.`
  );
  if (ENSAIO) console.log('Modo ensaio: nenhum relatório será gravado.');
  console.log('');

  let servidor = null;
  try {
    const preparado = await prepararBanco();
    const medidos = new HorariosMedidos();
    servidor = criarApp({ verificarToken: verificadorFalso, horarios: medidos }).listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));
    const url = `http://127.0.0.1:${servidor.address().port}`;

    // Aquecimento: abre as conexões HTTP e as do pool, e acorda o banco se ele
    // estiver hibernando. Não entra no relatório.
    await Promise.all(
      preparado.pacientes.map(async (p) => {
        const r = await fetch(`${url}/pacientes/me`, {
          headers: { Authorization: `Bearer ${p.token}` },
          signal: AbortSignal.timeout(PRAZO_POR_REQUISICAO_MS),
        });
        await r.arrayBuffer();
      })
    );
    const idaAoBancoMs = await medirIdaAoBanco();

    const base = new Date(Math.ceil((Date.now() + 30 * DIA_MS) / HORA_MS) * HORA_MS);
    const fases = await executarFases({ ...preparado, url, servidor, medidos, base });

    const [{ rows: versao }, { rows: isolamento }] = await Promise.all([
      consultar('SHOW server_version'),
      consultar('SHOW transaction_isolation'),
    ]);
    const quando = agoraNaClinica();
    const metadados = {
      data: quando.legivel,
      ...repositorio,
      node: process.version,
      sistema: `${os.type()} ${os.release()} ${os.arch()}`,
      postgres: versao[0].server_version,
      banco,
      isolamento: isolamento[0].transaction_isolation.toUpperCase(),
      idaAoBancoMs,
      transporte,
      pool: tamanhoDoPool,
      pedidosPorRodada: N,
      rodadas: RODADAS,
    };

    const todas = [...fases.A, ...fases.B, ...fases.C];
    const conflitos = todas.reduce((total, r) => total + r.avaliacao.conflitos, 0);
    const semAnomalia = todas.every((r) => r.avaliacao.aprovada);
    console.log(
      `\nCritério da Seção 4.5 (zero conflitos): ${conflitos === 0 ? 'ATENDIDO' : 'NÃO ATENDIDO'} — ` +
        `${conflitos} conflito(s).`
    );
    console.log(`Rodadas sem anomalia: ${todas.filter((r) => r.avaliacao.aprovada).length}/${todas.length}.`);

    if (!ENSAIO) {
      fs.mkdirSync(PASTA_RESULTADOS, { recursive: true });
      const nome = `${quando.arquivo}-${repositorio.commit}`;
      // 'wx': falha em vez de sobrescrever um relatório existente.
      fs.writeFileSync(
        path.join(PASTA_RESULTADOS, `${nome}.md`),
        montarMarkdown(metadados, fases.A, fases.B, fases.C),
        { flag: 'wx' }
      );
      fs.writeFileSync(
        path.join(PASTA_RESULTADOS, `${nome}.json`),
        `${JSON.stringify({ metadados, faseA: fases.A, faseB: fases.B, faseC: fases.C }, null, 2)}\n`,
        { flag: 'wx' }
      );
      console.log(`Relatório: docs/resultados/concorrencia/${nome}.md`);
      if (!repositorio.arvoreLimpa) {
        console.log('Aviso: havia alterações não commitadas — o commit citado não é exatamente o código medido.');
      }
    }

    // Anomalia também reprova o processo: um 500 no meio da rajada é defeito,
    // mesmo sem duplicidade. O relatório é que separa as duas coisas.
    process.exitCode = semAnomalia ? 0 : 1;
  } finally {
    // Sempre, inclusive depois de um erro: um servidor escutando mantém o Node
    // vivo, e o processo ficaria pendurado em vez de terminar com falha.
    if (servidor) {
      servidor.closeAllConnections();
      await new Promise((resolve) => servidor.close(resolve));
    }
    await encerrar().catch(() => {});
  }
}

principal().catch((erro) => {
  console.error('\nO experimento não terminou:', erro);
  process.exitCode = 1;
});
