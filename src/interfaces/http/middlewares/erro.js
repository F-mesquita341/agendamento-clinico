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
      },
    });
  }

  if (erro?.type === 'entity.parse.failed') {
    return res.status(400).json({
      erro: {
        codigo: 'JSON_INVALIDO',
        mensagem: 'O corpo da requisição não é um JSON válido.',
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
