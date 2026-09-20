'use strict';

/**
 * A trava de sandbox: a API não sobe com credencial de conta real.
 *
 * O trabalho simula o pagamento (Quadro 2, Seção 3.9.5). As sessões de teste
 * são feitas com participantes, e nenhuma delas pode gerar cobrança de
 * verdade. Até aqui a proteção era o domínio recusar pagamento com `live_mode`
 * verdadeiro; a primeira ligação com o Mercado Pago real mostrou que esse
 * campo não distingue nada — conta de teste também opera em modo produção. Ver
 * o comentário em domain/Pagamento.js.
 *
 * Esta é a proteção que ficou no lugar dela, e é melhor em dois aspectos:
 * acontece na SUBIDA, antes de existir qualquer cobrança, e pergunta ao
 * provedor de quem é a credencial em vez de inferir de um pagamento já feito.
 *
 * Falha fechada. Se o provedor não responde, a API não sobe: "não consegui
 * verificar" não é o mesmo que "está tudo bem", e esta é a única verificação
 * entre o trabalho e o dinheiro de alguém. Para desenvolver sem rede, tire
 * MERCADO_PAGO_ACCESS_TOKEN do .env — sem credencial não há o que travar, e a
 * rota de pagamento responde 503.
 */

/**
 * @param {import('../../domain/pagamentos').GatewayDePagamento} gateway
 * @returns {Promise<{liberado: boolean, motivo: string|null, conta: object|null,
 *                    mensagem: string|null}>}
 */
async function verificarContaDeSandbox(gateway) {
  let conta;
  try {
    conta = await gateway.descreverConta();
  } catch (erro) {
    return {
      liberado: false,
      motivo: 'nao_verificada',
      conta: null,
      mensagem:
        'Não foi possível confirmar com o Mercado Pago que a credencial é de uma\n' +
        `conta de teste (${erro.message}).\n` +
        'A API não sobe sem essa confirmação. Para trabalhar sem rede, remova\n' +
        'MERCADO_PAGO_ACCESS_TOKEN do .env.',
    };
  }

  if (!conta.ehContaDeTeste) {
    return {
      liberado: false,
      motivo: 'conta_real',
      conta,
      mensagem:
        `A credencial do Mercado Pago pertence à conta ${conta.id} ` +
        `(${conta.apelido ?? 'sem apelido'}), que NÃO é uma conta de teste.\n` +
        'Este trabalho só opera em sandbox: um pagamento aqui seria dinheiro de\n' +
        'verdade, de um participante de pesquisa. Troque pelo Access Token de uma\n' +
        'conta de teste, no painel do Mercado Pago, em Contas de teste.',
    };
  }

  return { liberado: true, motivo: null, conta, mensagem: null };
}

module.exports = { verificarContaDeSandbox };
