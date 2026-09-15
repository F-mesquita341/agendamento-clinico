'use strict';

/**
 * Validação de entrada com Zod, traduzida para o envelope de erro da API.
 *
 * Toda entrada que vem do cliente — query, corpo, parâmetro de rota — passa
 * por aqui antes de chegar ao caso de uso. Quando falha, o cliente recebe 422
 * com a lista de campos problemáticos, e não um 500 vindo do banco.
 */

const { RegraDeNegocio } = require('../../domain/erros');

class DadosInvalidos extends RegraDeNegocio {
  constructor(problemas) {
    super('DADOS_INVALIDOS', 'Alguns campos não foram preenchidos corretamente.');
    this.problemas = problemas;
  }
}

function validar(esquema, valor) {
  const resultado = esquema.safeParse(valor);
  if (!resultado.success) {
    throw new DadosInvalidos(
      resultado.error.issues.map((i) => ({
        campo: i.path.join('.') || '(raiz)',
        mensagem: i.message,
      }))
    );
  }
  return resultado.data;
}

module.exports = { validar, DadosInvalidos };
