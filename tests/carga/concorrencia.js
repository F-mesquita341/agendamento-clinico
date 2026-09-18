'use strict';

/**
 * Teste de carga da Seção 4.5: cem requisições simultâneas pelo mesmo horário.
 *
 * Critério do projeto: "zero conflitos detectados no teste de carga simples com
 * cem requisições simultâneas para o mesmo horário". Conflito, aqui, é
 * agendamento duplicado — ver o vocabulário em ./avaliacao.js.
 *
 * Duas fases, porque são duas perguntas:
 *
 *   A — o SISTEMA aguenta? 100 pacientes distintos fazem POST /consultas ao
 *       mesmo tempo, pelo caminho inteiro: token, perfil, checagem prévia,
 *       transação. Um contador separa as recusas decididas pela checagem
 *       prévia das decididas pelo UPDATE com a versão; sem essa separação o
 *       experimento poderia passar sem nunca exercitar o mecanismo.
 *
 *   B — é o LOCK que garante? 100 chamadas simultâneas direto ao adaptador,
 *       sem a checagem prévia. Toda recusa aqui é do UPDATE.
 *
 * Uso:
 *   npm run carga               10 rodadas por fase, relatório gravado em
 *                               docs/resultados/concorrencia/
 *   npm run carga -- --ensaio   as mesmas rodadas, sem gravar relatório
 *
 * Roda SEMPRE contra o banco de teste, que é apagado no início — o mesmo que a
 * suíte faz. Pacientes distintos em cada requisição: com o mesmo paciente,
 * parte das recusas viria da regra de agenda sobreposta, e o número misturaria
 * dois fenômenos.
 */

// Antes de qualquer require: config.js lê o ambiente ao ser carregado. O modo
// de teste é o que garante o banco de teste, e aborta se ele coincidir com o
// de desenvolvimento. O pool de 10 é o mesmo de produção.
process.env.NODE_ENV = 'test';
process.env.POOL_MAXIMO ??= '10';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const config = require('../../src/config');
const { criarApp } = require('../../src/interfaces/http/app');
const { consultar, encerrar, transporte } = require('../../src/infra/db/pool');
const { RepositorioDeHorariosPg } = require('../../src/infra/db/RepositorioDeHorariosPg');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../../src/domain/Paciente');
const { FUSO_DA_CLINICA } = require('../../src/interfaces/http/esquemas');
const { semear } = require('../helpers/semente');
const { verificadorFalso, tokenDe } = require('../helpers/verificadorFalso');
const { resumir, avaliarRodadaHttp, avaliarRodadaAdaptador } = require('./avaliacao');

const N = 100;
const RODADAS = 10;
const ENSAIO = process.argv.includes('--ensaio');
const PRAZO_POR_REQUISICAO_MS = 60_000;
const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;

const PASTA_RESULTADOS = path.join(__dirname, '..', '..', 'docs', 'resultados', 'concorrencia');

/**
 * Conta quantos pedidos chegaram ao UPDATE e quantos perderam lá.
 *
 * Subclasse usada só aqui: nenhum comportamento de produção muda. A rota a
 * recebe por injeção, pelo mesmo caminho que os testes usam para o verificador
 * de token.
 */
class HorariosMedidos extends RepositorioDeHorariosPg {
  constructor() {
    super();
    this.zerar();
  }

  zerar() {
    this.tentativas = 0;
    this.perdidas = 0;
  }

  async reservarEAgendar(dados) {
    this.tentativas += 1;
    const consulta = await super.reservarEAgendar(dados);
    if (!consulta) this.perdidas += 1;
    return consulta;
  }
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

  return { profissionalId, preco: precos[0].valor_consulta_centavos, pacientes };
}

/**
 * Horários em instantes que nunca colidem: um dia por rodada, a fase A de
 * manhã e a B à tarde, a partir de 30 dias no futuro — longe dos horários do
 * seed e sem sobreposição que acione a regra de agenda do paciente.
 */
function inicioDoHorario(base, rodada, fase) {
  return new Date(base.getTime() + rodada * DIA_MS + (fase === 'B' ? 4 * HORA_MS : 0));
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

// --- Fase A: o sistema, via HTTP --------------------------------------------

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

async function rodadaHttp(numero, contexto) {
  const { url, servidor, medidos, base, profissionalId, pacientes, preco } = contexto;

  const horarioId = await criarHorario(profissionalId, inicioDoHorario(base, numero, 'A'));
  const corpo = JSON.stringify({ horarioId, versao: 0 });

  medidos.zerar();
  // Instante em que cada requisição CHEGA ao servidor — a medida honesta de
  // simultaneidade. O instante de disparo no cliente diria pouco: o laço que
  // cria as cem promessas leva menos de um milissegundo.
  const chegadas = [];
  const aoChegar = () => chegadas.push(performance.now());
  servidor.on('request', aoChegar);

  const inicio = performance.now();
  const respostas = await Promise.all(
    pacientes.map((p) => pedir(`${url}/consultas`, p.token, corpo))
  );
  const duracao = performance.now() - inicio;
  servidor.off('request', aoChegar);

  const banco = await estadoDoHorario(horarioId);
  const avaliacao = avaliarRodadaHttp({ n: N, respostas, banco, precoEsperado: preco });

  const recusas409 = respostas.filter((r) => r.status === 409).length;
  const vencedor = respostas.find((r) => r.status === 201);

  return {
    rodada: numero,
    horarioId,
    criadas: respostas.filter((r) => r.status === 201).length,
    recusas: recusas409,
    outras: respostas.filter((r) => r.status !== 201 && r.status !== 409).length,
    recusasNoLock: medidos.perdidas,
    recusasNaChecagemPrevia: recusas409 - medidos.perdidas,
    chegaramAoUpdate: medidos.tentativas,
    janelaDeChegadaMs: chegadas.length ? Math.max(...chegadas) - Math.min(...chegadas) : null,
    duracaoMs: duracao,
    latencia: resumir(respostas.map((r) => r.ms)),
    vencedorMs: vencedor?.ms ?? null,
    latenciasMs: respostas.map((r) => Math.round(r.ms * 10) / 10),
    banco,
    avaliacao,
  };
}

// --- Fase B: o mecanismo, direto no adaptador -------------------------------

async function rodadaAdaptador(numero, contexto) {
  const { base, profissionalId, pacientes } = contexto;

  const horarioId = await criarHorario(profissionalId, inicioDoHorario(base, numero, 'B'));
  const repositorio = new RepositorioDeHorariosPg();
  const reservaExpiraEm = new Date(Date.now() + config.RESERVA_MINUTOS * 60_000);

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

  const banco = await estadoDoHorario(horarioId);
  const avaliacao = avaliarRodadaAdaptador({ n: N, resultados, banco });

  return {
    rodada: numero,
    horarioId,
    consultas: resultados.filter((r) => r.tipo === 'consulta').length,
    recusasNoLock: resultados.filter((r) => r.tipo === 'nulo').length,
    excecoes: resultados.filter((r) => r.tipo === 'erro').length,
    duracaoMs: duracao,
    latencia: resumir(resultados.map((r) => r.ms)),
    latenciasMs: resultados.map((r) => Math.round(r.ms * 10) / 10),
    banco,
    avaliacao,
  };
}

// --- Relatório --------------------------------------------------------------

function git(comando) {
  try {
    return execSync(`git ${comando}`, { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function agoraNaClinica() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: FUSO_DA_CLINICA,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return {
    arquivo: `${partes.year}-${partes.month}-${partes.day}-${partes.hour}${partes.minute}`,
    legivel: `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`,
  };
}

const ms = (valor) => (valor === null ? '—' : Math.round(valor).toString());

function montarMarkdown(metadados, faseA, faseB) {
  const conflitosA = faseA.reduce((soma, r) => soma + r.avaliacao.conflitos, 0);
  const conflitosB = faseB.reduce((soma, r) => soma + r.avaliacao.conflitos, 0);
  const aprovadasA = faseA.filter((r) => r.avaliacao.aprovada).length;
  const aprovadasB = faseB.filter((r) => r.avaliacao.aprovada).length;
  const atendido = aprovadasA === RODADAS && aprovadasB === RODADAS;

  const todasA = faseA.flatMap((r) => r.latenciasMs);
  const geralA = resumir(todasA);
  const noLock = faseA.reduce((s, r) => s + r.recusasNoLock, 0);
  const naChecagem = faseA.reduce((s, r) => s + r.recusasNaChecagemPrevia, 0);
  const totalRecusas = noLock + naChecagem;
  const pct = (parte) => (totalRecusas ? ((100 * parte) / totalRecusas).toFixed(1) : '0.0');

  const linhasA = faseA.map(
    (r) =>
      `| ${r.rodada} | ${r.criadas} | ${r.recusas} | ${r.outras} | ${r.recusasNaChecagemPrevia} | ` +
      `${r.recusasNoLock} | ${r.banco.consultasAtivas} | ${ms(r.janelaDeChegadaMs)} | ` +
      `${ms(r.duracaoMs)} | ${ms(r.latencia.p50)} | ${ms(r.latencia.p95)} | ` +
      `${ms(r.latencia.maximo)} | ${ms(r.vencedorMs)} | ${r.avaliacao.aprovada ? '✓' : '✗'} |`
  );
  const linhasB = faseB.map(
    (r) =>
      `| ${r.rodada} | ${r.consultas} | ${r.recusasNoLock} | ${r.excecoes} | ` +
      `${r.banco.consultasAtivas} | ${ms(r.duracaoMs)} | ${ms(r.latencia.p50)} | ` +
      `${ms(r.latencia.p95)} | ${ms(r.latencia.maximo)} | ${r.avaliacao.aprovada ? '✓' : '✗'} |`
  );

  const falhas = [...faseA, ...faseB]
    .filter((r) => !r.avaliacao.aprovada)
    .map((r) => `- Rodada ${r.rodada}: ${r.avaliacao.falhas.join('; ')}`);

  return `# Teste de concorrência — ${metadados.data}

Critério da Seção 4.5 do projeto: **zero conflitos** no teste de carga com cem
requisições simultâneas para o mesmo horário.

**Resultado: ${atendido ? 'ATENDIDO' : 'NÃO ATENDIDO'}** — ${conflitosA} conflito(s) em
${RODADAS} rodadas via HTTP (${aprovadasA}/${RODADAS} aprovadas) e ${conflitosB} conflito(s) em
${RODADAS} rodadas direto no adaptador (${aprovadasB}/${RODADAS} aprovadas).

## Vocabulário

- **Conflito** — agendamento duplicado: mais de uma consulta ativa no mesmo
  horário. É o que o critério exige que seja zero.
- **Recusa** — resposta \`409 HORARIO_INDISPONIVEL\` a quem perdeu a disputa.
  É o resultado correto: ${N - 1} por rodada é o esperado. O HTTP chama o 409 de
  *Conflict*, mas recusa não é conflito — conflito seria ela *não* acontecer.

## Ambiente

| | |
|---|---|
| Data | ${metadados.data} (horário de Fortaleza) |
| Commit | \`${metadados.commit}\`${metadados.arvoreLimpa ? '' : ' — **com alterações não commitadas**'} |
| Node.js | ${metadados.node} |
| Sistema | ${metadados.sistema} |
| Banco | PostgreSQL ${metadados.postgres}, Neon (São Paulo), banco de teste |
| Transporte | ${metadados.transporte} |
| Pool de conexões | ${metadados.pool} |
| Requisições por rodada | ${N}, cada uma de um paciente diferente |
| Rodadas por fase | ${RODADAS}, precedidas de um aquecimento não contabilizado |

## Fase A — o sistema, via HTTP

Cem \`POST /consultas\` simultâneos pelo mesmo horário, com a mesma versão, pelo
caminho completo da API. As recusas são separadas pela camada que as decidiu:
**checagem prévia** (o pedido leu o horário já reservado, antes da transação) e
**lock** (chegou ao \`UPDATE ... WHERE versao\` e não encontrou a versão).

| Rodada | 201 | 409 | outras | recusas na checagem | recusas no lock | consultas no horário | chegada (ms) | duração (ms) | p50 | p95 | máx | vencedor (ms) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${linhasA.join('\n')}

- Latência das ${todasA.length} requisições: p50 ${ms(geralA.p50)} ms, p95 ${ms(geralA.p95)} ms, máximo ${ms(geralA.maximo)} ms.
- Recusas: ${pct(naChecagem)}% decididas pela checagem prévia, ${pct(noLock)}% pelo lock.
- **Chegada** é o intervalo entre a primeira e a última requisição a chegar ao
  servidor: mede a simultaneidade real, e não o tempo do laço que as disparou.

## Fase B — o mecanismo, direto no adaptador

Cem chamadas simultâneas a \`reservarEAgendar\`, sem a checagem prévia do caso de
uso. Toda recusa aqui é decidida pelo \`UPDATE\` com a versão.

| Rodada | consultas criadas | recusas no lock | exceções | consultas no horário | duração (ms) | p50 | p95 | máx | |
|---|---|---|---|---|---|---|---|---|---|
${linhasB.join('\n')}
${falhas.length ? `\n## Falhas\n\n${falhas.join('\n')}\n` : ''}
## Limitações

- Cliente e servidor rodam no mesmo processo; as latências incluem o trabalho
  do próprio gerador de carga.
- O token é verificado por um dublê com o mesmo contrato do Firebase; o custo de
  verificar a assinatura do JWT fica de fora.
- Máquina local contra o Neon em São Paulo: a latência de rede domina os
  números absolutos, que não devem ser lidos como desempenho em produção.
- Um único horário disputado por rodada — o pior caso de contenção, e não uma
  carga típica de clínica.
`;
}

// --- Execução ---------------------------------------------------------------

async function principal() {
  console.log(`\nTeste de concorrência: ${RODADAS} rodadas × ${N} requisições, pool de ${config.POOL_MAXIMO}.`);
  console.log(ENSAIO ? 'Modo ensaio: nenhum relatório será gravado.\n' : '');

  const preparado = await prepararBanco();
  const medidos = new HorariosMedidos();
  const servidor = criarApp({ verificarToken: verificadorFalso, horarios: medidos }).listen(0);
  await new Promise((resolve) => servidor.once('listening', resolve));
  const url = `http://127.0.0.1:${servidor.address().port}`;

  const base = new Date(Math.ceil((Date.now() + 30 * DIA_MS) / HORA_MS) * HORA_MS);
  const contexto = { ...preparado, url, servidor, medidos, base };

  // Aquecimento: abre as conexões HTTP e as do pool, e acorda o banco se ele
  // estiver hibernando. Não entra no relatório.
  await Promise.all(
    preparado.pacientes.map((p) =>
      fetch(`${url}/pacientes/me`, { headers: { Authorization: `Bearer ${p.token}` } })
    )
  );

  const faseA = [];
  for (let i = 1; i <= RODADAS; i += 1) {
    const r = await rodadaHttp(i, contexto);
    faseA.push(r);
    console.log(
      `A ${String(i).padStart(2)}/${RODADAS}  ${r.criadas}×201  ${r.recusas}×409 ` +
        `(checagem ${r.recusasNaChecagemPrevia}, lock ${r.recusasNoLock})  ` +
        `conflitos ${r.avaliacao.conflitos}  ${ms(r.duracaoMs)} ms  ${r.avaliacao.aprovada ? '✓' : '✗ ' + r.avaliacao.falhas.join('; ')}`
    );
  }

  const faseB = [];
  for (let i = 1; i <= RODADAS; i += 1) {
    const r = await rodadaAdaptador(i, contexto);
    faseB.push(r);
    console.log(
      `B ${String(i).padStart(2)}/${RODADAS}  ${r.consultas} consulta  ${r.recusasNoLock} recusas no lock  ` +
        `conflitos ${r.avaliacao.conflitos}  ${ms(r.duracaoMs)} ms  ${r.avaliacao.aprovada ? '✓' : '✗ ' + r.avaliacao.falhas.join('; ')}`
    );
  }

  servidor.closeAllConnections();
  await new Promise((resolve) => servidor.close(resolve));

  const { rows } = await consultar('SHOW server_version');
  const quando = agoraNaClinica();
  const metadados = {
    data: quando.legivel,
    commit: git('rev-parse --short HEAD') ?? 'desconhecido',
    arvoreLimpa: git('status --porcelain') === '',
    node: process.version,
    sistema: `${os.type()} ${os.release()} ${os.arch()}`,
    postgres: rows[0].server_version,
    transporte,
    pool: config.POOL_MAXIMO,
    requisicoesPorRodada: N,
    rodadas: RODADAS,
  };

  await encerrar();

  const aprovado = [...faseA, ...faseB].every((r) => r.avaliacao.aprovada);
  console.log(`\n${aprovado ? 'Critério da Seção 4.5 ATENDIDO' : 'Critério da Seção 4.5 NÃO ATENDIDO'}.`);

  if (!ENSAIO) {
    fs.mkdirSync(PASTA_RESULTADOS, { recursive: true });
    const nome = `${quando.arquivo}-${metadados.commit}`;
    fs.writeFileSync(path.join(PASTA_RESULTADOS, `${nome}.md`), montarMarkdown(metadados, faseA, faseB));
    fs.writeFileSync(
      path.join(PASTA_RESULTADOS, `${nome}.json`),
      `${JSON.stringify({ metadados, faseA, faseB }, null, 2)}\n`
    );
    console.log(`Relatório: docs/resultados/concorrencia/${nome}.md`);
    if (!metadados.arvoreLimpa) {
      console.log('Aviso: havia alterações não commitadas — o commit citado não é exatamente o código medido.');
    }
  }

  process.exitCode = aprovado ? 0 : 1;
}

principal().catch(async (erro) => {
  console.error('\nO experimento não terminou:', erro);
  await encerrar().catch(() => {});
  process.exitCode = 1;
});
