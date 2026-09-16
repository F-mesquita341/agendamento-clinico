'use strict';

/**
 * Tradução de erro para resposta HTTP.
 *
 * Todo erro sai da API no mesmo envelope:
 *
 *   { "erro": { "codigo": "...", "mensagem": "...", "acao": "..." } }
 *
 * Erros de domínio viram o status que eles declaram. Qualquer outra coisa
 * vira 500 com mensagem genérica: detalhe interno fica no log do servidor,
 * nunca na resposta ao cliente.
 */

const { ErroDeDominio } = require('../../../domain/erros');
const config = require('../../../config');

/**
 * Erros levantados pelo `express.json()` antes de qualquer rota rodar.
 *
 * Eles chegam com `type` e `status` próprios, e nenhum é falha do servidor —
 * são todos problemas do que o cliente enviou. Sem este mapa, um corpo acima
 * do limite viraria 500 com `ERRO_INTERNO`, e cada requisição grande demais
 * apareceria no log como erro interno, escondendo falhas de verdade.
 */
const ERROS_DO_CORPO = {
  'entity.parse.failed': {
    status: 400,
    codigo: 'JSON_INVALIDO',
    mensagem: 'O corpo da requisição não é um JSON válido.',
  },
  'entity.too.large': {
    status: 413,
    codigo: 'CORPO_GRANDE_DEMAIS',
    mensagem: 'O conteúdo enviado é maior do que o limite aceito.',
  },
  'encoding.unsupported': {
    status: 415,
    codigo: 'CODIFICACAO_NAO_SUPORTADA',
    mensagem: 'A codificação do conteúdo enviado não é suportada.',
  },
  'charset.unsupported': {
    status: 415,
    codigo: 'CHARSET_NAO_SUPORTADO',
    mensagem: 'O conjunto de caracteres do conteúdo enviado não é suportado.',
  },
};

function rotaNaoEncontrada(req, res, next) {
  res.status(404).json({
    erro: {
      codigo: 'ROTA_NAO_ENCONTRADA',
      mensagem: `Não existe ${req.method} ${req.path} nesta API.`,
      acao: null,
    },
  });
}

// O Express identifica o tratador de erro pela aridade 4. Não remova `next`.
// eslint-disable-next-line no-unused-vars
function tratadorDeErro(erro, req, res, next) {
  if (erro instanceof ErroDeDominio) {
    return res.status(erro.status).json({
      erro: {
        codigo: erro.codigo,
        mensagem: erro.message,
        acao: erro.acao,
        // Erros de validação carregam a lista de campos problemáticos, para
        // que o aplicativo possa destacar cada um no formulário.
        ...(erro.problemas ? { problemas: erro.problemas } : {}),
      },
    });
  }

  const doCorpo = ERROS_DO_CORPO[erro?.type];
  if (doCorpo) {
    return res.status(doCorpo.status).json({
      erro: { codigo: doCorpo.codigo, mensagem: doCorpo.mensagem, acao: null },
    });
  }

  // Rede de segurança para qualquer outro erro que já se declare como falha do
  // cliente — inclusive versões futuras do body-parser com tipos novos. Um 4xx
  // nunca deve virar 500: são problemas distintos e exigem reação distinta de
  // quem chamou.
  if (Number.isInteger(erro?.status) && erro.status >= 400 && erro.status < 500) {
    return res.status(erro.status).json({
      erro: {
        codigo: 'REQUISICAO_INVALIDA',
        mensagem: 'A requisição não pôde ser processada como enviada.',
        acao: null,
      },
    });
  }

  console.error('Erro não tratado:', erro);

  return res.status(500).json({
    erro: {
      codigo: 'ERRO_INTERNO',
      mensagem: 'Algo deu errado do nosso lado. Tente novamente em instantes.',
      acao: null,
      ...(config.NODE_ENV === 'development' ? { detalhe: erro?.message } : {}),
    },
  });
}

module.exports = { rotaNaoEncontrada, tratadorDeErro };
