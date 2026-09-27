'use strict';

/**
 * Exporta o conjunto de dados da pesquisa, pseudonimizado — Etapa 10.
 *
 * A Seção 4.6 da proposta promete que todos os dados coletados serão
 * pseudonimizados, e a 4.7, o descarte ao fim da pesquisa. Este script é o
 * elo entre a promessa e o banco: tira dele só o que a análise precisa, com
 * paciente e consulta trocados por pseudônimos. Como eles são feitos, e o que
 * fica de fora, está em ./exportacao/pseudonimizar.js.
 *
 * Uso:
 *
 *   npm run exportar:pesquisa -- --saida C:\pesquisa\exportacao-2026-10
 *
 * Grava consultas.csv e eventos.csv na pasta indicada. Nunca sobrescreve: se
 * os arquivos já existirem lá, recusa, e nada é gravado.
 *
 * RECUSA GRAVAR DENTRO DO REPOSITÓRIO. Ele é público, e dado de participante
 * não pode acabar num commit por um `git add` distraído — nem pseudonimizado.
 *
 * Exige SEGREDO_PSEUDONIMIZACAO no ambiente (o .env serve). Para gerar um, no
 * SEU terminal — ele não deve aparecer em conversa, log nem commit:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Guarde-o como uma senha: no .env, que não vai para o Git, ou fora do
 * repositório — nunca num arquivo versionado. O mesmo segredo dá os mesmos
 * pseudônimos de uma exportação para outra; descartá-lo ao fim da pesquisa,
 * junto com o banco, é o que desfaz de vez a associação com as pessoas.
 *
 * O banco é o da configuração, como na API: DATABASE_URL. Para exportar o de
 * produção, defina-a no terminal antes de rodar. O script mostra host e nome
 * do banco — nunca usuário nem senha.
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const { transacao, encerrar } = require('../src/infra/db/pool');
const {
  COLUNAS_DE_CONSULTAS,
  COLUNAS_DE_EVENTOS,
  SegredoInadequado,
  criarPseudonimizador,
  linhaDeConsulta,
  linhaDeEvento,
  paraCsv,
  estaDentro,
  haColisao,
} = require('./exportacao/pseudonimizar');

const RAIZ = path.resolve(__dirname, '..');

const USO = 'Uso: npm run exportar:pesquisa -- --saida <pasta fora do repositório>';

class Recusa extends Error {}

const SQL_CONSULTAS = `
  SELECT c.id AS consulta_id, c.paciente_id, c.status, c.motivo_cancelamento,
         h.inicio, c.criado_em, c.lembrete_enviado_em,
         EXISTS (
           SELECT 1 FROM pagamento p
            WHERE p.consulta_id = c.id AND p.status = 'aprovado'
         ) AS paga
    FROM consulta c
    JOIN horario h ON h.id = c.horario_id
   ORDER BY c.id`;

// O paciente de cada evento: o da própria linha quando o evento é sobre ele; o
// dono da consulta quando é sobre consulta ou pagamento; e, nos eventos de
// aparelho — cuja linha pode já ter sido apagada —, quem agiu.
const SQL_EVENTOS = `
  SELECT a.ator_tipo, a.acao, a.criado_em,
         COALESCE(
           CASE a.entidade
             WHEN 'paciente'  THEN a.entidade_id
             WHEN 'consulta'  THEN c.paciente_id
             WHEN 'pagamento' THEN cp.paciente_id
           END,
           CASE WHEN a.ator_tipo = 'paciente' THEN a.ator_id END
         ) AS paciente_id,
         CASE a.entidade
           WHEN 'consulta'  THEN a.entidade_id
           WHEN 'pagamento' THEN p.consulta_id
         END AS consulta_id
    FROM auditoria a
    LEFT JOIN consulta  c  ON a.entidade = 'consulta'  AND c.id = a.entidade_id
    LEFT JOIN pagamento p  ON a.entidade = 'pagamento' AND p.id = a.entidade_id
    LEFT JOIN consulta  cp ON cp.id = p.consulta_id
   ORDER BY a.id`;

/**
 * Caminho absoluto, com atalhos desfeitos no trecho que já existe. Sem isso,
 * um atalho de fora apontando para dentro do repositório passaria pela guarda.
 */
function caminhoReal(alvo) {
  let existente = path.resolve(alvo);
  const faltando = [];
  while (!fs.existsSync(existente)) {
    const pai = path.dirname(existente);
    if (pai === existente) {
      // Chegou à raiz sem achar nada: no Windows, um disco que não existe.
      throw new Recusa(`Recusado: ${path.resolve(alvo)} está num disco que não existe.`);
    }
    faltando.unshift(path.basename(existente));
    existente = pai;
  }
  return path.join(fs.realpathSync.native(existente), ...faltando);
}

/** Host e nome do banco, sem usuário nem senha. */
function descreverBanco(url) {
  try {
    const endereco = new URL(url);
    return `${endereco.hostname}${endereco.pathname}`;
  } catch {
    return '(endereço do banco ilegível)';
  }
}

/**
 * @param {object} opcoes
 * @param {string} opcoes.saida pasta de destino, fora do repositório
 * @param {string} opcoes.segredo SEGREDO_PSEUDONIMIZACAO
 * @param {string} [opcoes.raiz] raiz do repositório; os testes não a mudam
 * @param {Function} [opcoes.entreAsLeituras] SÓ PARA OS TESTES: chamada com o
 *        cliente da transação entre as duas leituras, para provar que elas
 *        saem do mesmo instante do banco e que a transação não escreve
 */
async function exportar({ saida, segredo, raiz = RAIZ, entreAsLeituras }) {
  // Segredo e pasta são conferidos antes de qualquer leitura do banco.
  const pseudonimo = criarPseudonimizador(segredo);

  const destino = caminhoReal(saida);
  if (estaDentro(destino, caminhoReal(raiz))) {
    throw new Recusa(
      `Recusado: ${destino} fica dentro do repositório, que é público.\n` +
        'Dado de participante não pode acabar num commit. Escolha uma pasta fora dele.'
    );
  }

  const arquivos = ['consultas.csv', 'eventos.csv'].map((nome) => path.join(destino, nome));
  const existentes = arquivos.filter((arquivo) => fs.existsSync(arquivo));
  if (existentes.length > 0) {
    throw new Recusa(
      `Recusado: já existe ${existentes.join(' e ')}.\n` +
        'A exportação nunca sobrescreve. Escolha uma pasta nova.'
    );
  }

  // As duas leituras numa transação só:
  //   REPEATABLE READ — a fotografia do banco é tirada na primeira consulta e
  //     vale para a segunda. Lidas em separado, um agendamento que entrasse
  //     entre elas apareceria em eventos.csv sem estar em consultas.csv.
  //   READ ONLY — a exportação não tem por que escrever, e o próprio banco
  //     passa a garantir que não escreve.
  const { consultas, eventos } = await transacao(async (cliente) => {
    await cliente.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: lidasConsultas } = await cliente.query(SQL_CONSULTAS);
    if (entreAsLeituras) await entreAsLeituras(cliente);
    const { rows: lidosEventos } = await cliente.query(SQL_EVENTOS);
    return { consultas: lidasConsultas, eventos: lidosEventos };
  });

  const pacientes = [...consultas, ...eventos].map((l) => l.paciente_id);
  const consultasCitadas = [...consultas, ...eventos].map((l) => l.consulta_id);
  if (haColisao(pacientes, pseudonimo.paciente) || haColisao(consultasCitadas, pseudonimo.consulta)) {
    // Com 64 bits, praticamente impossível; mas, se acontecer, duas pessoas
    // virariam uma só na análise, sem nenhum sinal disso nos arquivos.
    throw new Recusa('Recusado: dois ids deram o mesmo pseudônimo. Gere outro segredo e exporte de novo.');
  }

  const [arquivoDeConsultas, arquivoDeEventos] = arquivos;
  const conteudoDeConsultas = paraCsv(
    COLUNAS_DE_CONSULTAS,
    consultas.map((linha) => linhaDeConsulta(linha, pseudonimo))
  );
  const conteudoDeEventos = paraCsv(
    COLUNAS_DE_EVENTOS,
    eventos.map((linha) => linhaDeEvento(linha, pseudonimo))
  );

  fs.mkdirSync(destino, { recursive: true });
  // 'wx': falha em vez de sobrescrever, se algo surgir entre a conferência e a
  // gravação.
  fs.writeFileSync(arquivoDeConsultas, conteudoDeConsultas, { flag: 'wx' });
  fs.writeFileSync(arquivoDeEventos, conteudoDeEventos, { flag: 'wx' });

  return { destino, consultas: consultas.length, eventos: eventos.length };
}

async function principal() {
  const i = process.argv.indexOf('--saida');
  const saida = i >= 0 ? process.argv[i + 1] : undefined;
  if (!saida) {
    console.error(`\n${USO}\n`);
    process.exitCode = 1;
    return;
  }

  const segredo = process.env.SEGREDO_PSEUDONIMIZACAO;
  if (!segredo) {
    console.error(
      '\nSEGREDO_PSEUDONIMIZACAO não definida. Gere uma no seu terminal com\n' +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\n` +
        'e guarde-a como uma senha: no .env, que não vai para o Git — ver o\n' +
        'cabeçalho deste script.\n'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nBanco: ${descreverBanco(config.urlDoBanco)}`);

  try {
    const r = await exportar({ saida, segredo });
    console.log(`Exportado em ${r.destino}:`);
    console.log(`  consultas.csv  ${r.consultas} linha(s)`);
    console.log(`  eventos.csv    ${r.eventos} linha(s)\n`);
  } catch (erro) {
    if (!(erro instanceof Recusa || erro instanceof SegredoInadequado)) throw erro;
    console.error(`\n${erro.message}\n`);
    process.exitCode = 1;
  } finally {
    await encerrar();
  }
}

if (require.main === module) {
  principal().catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  });
}

module.exports = { exportar, Recusa };
