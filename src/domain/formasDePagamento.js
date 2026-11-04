'use strict';

/**
 * As formas de pagamento da versão 2 e a regra de quem aceita o quê.
 *
 * Função pura: o caso de uso não a chama, porque a aceitação só é conferida
 * com segurança DENTRO da transação do agendamento — é o adaptador quem lê o
 * profissional ali e pergunta a esta função. Se ela recusar, a exceção desfaz
 * a reserva (ROLLBACK), como já acontece com o profissional desativado.
 */

const { RegraDeNegocio } = require('./erros');

/**
 * Na ordem em que o aplicativo as oferece. Pagar pelo aplicativo vem primeiro
 * porque é o fluxo original — o pagamento antecipado que é a premissa do
 * trabalho contra as faltas.
 */
const FORMA_DE_PAGAMENTO = Object.freeze({
  APP: 'app',
  PLANO: 'plano',
  CLINICA: 'clinica',
});

const FORMAS = Object.freeze(Object.values(FORMA_DE_PAGAMENTO));

/**
 * @param {object} p
 * @param {string} p.forma a forma escolhida
 * @param {boolean} p.aceitaPagamentoNoApp
 * @param {boolean} p.aceitaPagarNaClinica
 * @param {boolean} p.aceitaOPlano o profissional aceita o plano escolhido (falso
 *        também quando o plano nem existe — para o paciente, é a mesma coisa)
 */
function garantirQueAceita({ forma, aceitaPagamentoNoApp, aceitaPagarNaClinica, aceitaOPlano }) {
  const aceita = {
    [FORMA_DE_PAGAMENTO.APP]: aceitaPagamentoNoApp,
    [FORMA_DE_PAGAMENTO.CLINICA]: aceitaPagarNaClinica,
    [FORMA_DE_PAGAMENTO.PLANO]: aceitaOPlano,
  };
  if (!FORMAS.includes(forma)) {
    throw new TypeError(`Forma de pagamento desconhecida: ${forma}`);
  }
  if (aceita[forma] === true) return;

  if (forma === FORMA_DE_PAGAMENTO.PLANO) {
    throw new RegraDeNegocio(
      'PLANO_NAO_ACEITO',
      'Este profissional não atende por esse plano. Escolha outro plano ou outra forma de pagamento.'
    );
  }
  throw new RegraDeNegocio(
    'FORMA_DE_PAGAMENTO_NAO_ACEITA',
    'Este profissional não aceita essa forma de pagamento. Escolha outra forma.'
  );
}

module.exports = { FORMA_DE_PAGAMENTO, FORMAS, garantirQueAceita };
