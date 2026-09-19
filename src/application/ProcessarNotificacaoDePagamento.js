'use strict';

/**
 * Caso de uso: o provedor avisou que um pagamento mudou.
 *
 * O aviso só carrega o id. O estado é buscado no próprio provedor — a
 * notificação, mesmo assinada, nunca é a fonte de verdade — e aplicado sob
 * bloqueio pelo repositório, que pergunta ao domínio o que fazer.
 *
 * A assinatura já foi verificada pela rota: este caso de uso não sabe de
 * cabeçalhos nem de HMAC.
 */

class ProcessarNotificacaoDePagamento {
  constructor({ gateway, pagamentos }) {
    this.gateway = gateway;
    this.pagamentos = pagamentos;
  }

  /** @returns {Promise<{desfecho: string, anomalia: string|null}>} */
  async executar({ pagamentoId }) {
    const pagamento = await this.gateway.consultarPagamento(pagamentoId);
    if (!pagamento) {
      return { desfecho: 'pagamento_desconhecido', anomalia: null };
    }
    return this.pagamentos.aplicarPagamento(pagamento, { ator: 'webhook' });
  }
}

module.exports = { ProcessarNotificacaoDePagamento };
