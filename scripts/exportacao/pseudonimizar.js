'use strict';

/**
 * Parte pura da exportação para a pesquisa: pseudônimos, colunas, CSV e a
 * guarda da pasta de saída. Sem banco e sem disco, para ser testada sozinha.
 * Quem consulta o banco e grava os arquivos é scripts/exportar-pesquisa.js.
 *
 * PSEUDÔNIMO, NA DEFINIÇÃO DA LGPD (Art. 13, § 4º): o dado perde a associação
 * com a pessoa, "senão pelo uso de informação adicional mantida
 * separadamente". A informação adicional é o segredo. O pseudônimo é um
 * HMAC-SHA256 do id com ele: estável — o mesmo paciente tem o mesmo pseudônimo
 * em todos os arquivos, e de uma exportação para outra —, e impossível de
 * reverter sem o segredo. Um hash simples do id não serviria: ids são
 * sequenciais, e bastaria calcular o hash de 1, 2, 3... para desfazer tudo.
 *
 * COLUNAS POR LISTA FECHADA. Cada arquivo só grava as colunas nomeadas aqui.
 * Uma coluna nova no banco não entra na exportação por acidente: para sair,
 * ela precisa ser acrescentada a esta lista, à vista de quem revisar.
 */

const crypto = require('node:crypto');
const path = require('node:path');

// 32 caracteres: o que `randomBytes(16).toString('hex')` produz. Abaixo disso,
// o segredo começa a ser adivinhável por força bruta, e com ele todo o
// conjunto volta a ser identificável.
const TAMANHO_MINIMO_DO_SEGREDO = 32;

// 16 dígitos hexadecimais são 64 bits: a chance de dois pacientes colidirem
// num conjunto de pesquisa é desprezível — e o exportador confere mesmo assim.
const DIGITOS_DO_PSEUDONIMO = 16;

const COLUNAS_DE_CONSULTAS = [
  'consulta',
  'paciente',
  'status',
  'motivo_cancelamento',
  'inicio',
  'criada_em',
  'paga',
  'lembrete_enviado_em',
];

const COLUNAS_DE_EVENTOS = ['paciente', 'consulta', 'ator', 'acao', 'instante'];

class SegredoInadequado extends Error {}

/**
 * @param {string} segredo SEGREDO_PSEUDONIMIZACAO
 * @returns {{ paciente: (id) => string, consulta: (id) => string }}
 */
function criarPseudonimizador(segredo) {
  if (typeof segredo !== 'string' || segredo.length < TAMANHO_MINIMO_DO_SEGREDO) {
    throw new SegredoInadequado(
      `SEGREDO_PSEUDONIMIZACAO precisa ter ao menos ${TAMANHO_MINIMO_DO_SEGREDO} caracteres.`
    );
  }

  // O tipo entra na mensagem: sem ele, o paciente 7 e a consulta 7 teriam o
  // mesmo código, e o prefixo seria a única coisa a distingui-los.
  const codigo = (tipo, id) =>
    crypto
      .createHmac('sha256', segredo)
      .update(`${tipo}:${id}`)
      .digest('hex')
      .slice(0, DIGITOS_DO_PSEUDONIMO);

  const vazioOu = (prefixo, tipo) => (id) =>
    id === null || id === undefined ? '' : `${prefixo}-${codigo(tipo, id)}`;

  return {
    paciente: vazioOu('P', 'paciente'),
    consulta: vazioOu('C', 'consulta'),
  };
}

/** Instante em ISO 8601, UTC; vazio quando não há. */
function instante(valor) {
  return valor ? new Date(valor).toISOString() : '';
}

/**
 * Linha de `consultas.csv`, a partir da linha do banco.
 *
 * Fora, de propósito: profissional e especialidade — a especialidade revela a
 * condição de saúde (dado sensível, LGPD Art. 11) e, numa clínica pequena, o
 * profissional também —, valor, e todo identificador do Mercado Pago.
 */
function linhaDeConsulta(linha, pseudonimo) {
  return {
    consulta: pseudonimo.consulta(linha.consulta_id),
    paciente: pseudonimo.paciente(linha.paciente_id),
    status: linha.status,
    motivo_cancelamento: linha.motivo_cancelamento ?? '',
    inicio: instante(linha.inicio),
    criada_em: instante(linha.criado_em),
    paga: linha.paga ? 1 : 0,
    lembrete_enviado_em: instante(linha.lembrete_enviado_em),
  };
}

/**
 * Linha de `eventos.csv`, a partir da auditoria.
 *
 * O campo `detalhe` da auditoria não sai: é JSON livre, e o que cabe nele hoje
 * não é garantia do que caberá amanhã.
 */
function linhaDeEvento(linha, pseudonimo) {
  return {
    paciente: pseudonimo.paciente(linha.paciente_id),
    consulta: pseudonimo.consulta(linha.consulta_id),
    ator: linha.ator_tipo,
    acao: linha.acao,
    instante: instante(linha.criado_em),
  };
}

function escapar(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/** CSV com cabeçalho. Só as colunas pedidas, mesmo que a linha traga outras. */
function paraCsv(colunas, linhas) {
  const corpo = linhas.map((linha) => colunas.map((c) => escapar(linha[c])).join(','));
  return `${[colunas.join(','), ...corpo].join('\n')}\n`;
}

/**
 * A pasta fica dentro de `raiz`? Os dois caminhos já devem vir resolvidos —
 * absolutos, e com atalhos desfeitos (fs.realpathSync).
 */
function estaDentro(pasta, raiz) {
  const relativo = path.relative(raiz, pasta);
  if (relativo === '') return true;
  // `split` e não `startsWith('..')`: uma pasta chamada "..dados" dentro do
  // repositório começa com ".." e está dentro.
  return relativo.split(path.sep)[0] !== '..' && !path.isAbsolute(relativo);
}

/** Algum pseudônimo repetido para ids diferentes? */
function haColisao(ids, pseudonimizar) {
  const distintos = new Set(ids.filter((id) => id !== null && id !== undefined).map(String));
  const pseudonimos = new Set([...distintos].map(pseudonimizar));
  return pseudonimos.size !== distintos.size;
}

module.exports = {
  COLUNAS_DE_CONSULTAS,
  COLUNAS_DE_EVENTOS,
  TAMANHO_MINIMO_DO_SEGREDO,
  SegredoInadequado,
  criarPseudonimizador,
  linhaDeConsulta,
  linhaDeEvento,
  paraCsv,
  estaDentro,
  haColisao,
};
