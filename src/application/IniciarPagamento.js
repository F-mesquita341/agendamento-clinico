'use strict';

/**
 * Caso de uso: abrir o checkout de uma consulta que aguarda pagamento.
 *
 * Pedir de novo devolve o MESMO checkout enquanto ele estiver aberto. Dois
 * checkouts abertos para a mesma consulta permitiriam pagar duas vezes.
 *
 * O valor é o da consulta, congelado no agendamento — nunca informado pelo
 * aplicativo. O que o provedor recebe é o mínimo: descrição genérica, valor,
 * uma referência aleatória e o prazo, que é o mesmo da reserva.
 */

const crypto = require('node:crypto');
const { NaoEncontrado } = require('../domain/erros');
const { DESCRICAO_DO_ITEM } = require('../domain/Pagamento');
const { relogioDoSistema } = require('../domain/Relogio');

class IniciarPagamento {
  /**
   * @param {object} deps
   * @param {import('../domain/repositorios').RepositorioDeConsultas} deps.consultas
   * @param {import('../domain/pagamentos').RepositorioDePagamentos} deps.pagamentos
   * @param {import('../domain/pagamentos').GatewayDePagamento} deps.gateway
   * @param {{agora: () => Date}} [deps.relogio]
   * @param {() => string} [deps.gerarReferencia] referência externa; aleatória
   *        para não revelar ao provedor o id interno da consulta
   */
  constructor({
    consultas,
    pagamentos,
    gateway,
    relogio = relogioDoSistema,
    gerarReferencia = () => crypto.randomUUID(),
  }) {
    this.consultas = consultas;
    this.pagamentos = pagamentos;
    this.gateway = gateway;
    this.relogio = relogio;
    this.gerarReferencia = gerarReferencia;
  }

  /** @returns {Promise<{checkout: object, consulta: object, novo: boolean}>} */
  async executar({ pacienteId, consultaId }) {
    const consulta = await this.consultas.porId(consultaId);
    if (!consulta) {
      throw new NaoEncontrado('Consulta');
    }

    const agora = this.relogio.agora();
    consulta.garantirQuePodeSerPagaPor(pacienteId, agora);

    const aberto = await this.pagamentos.checkoutAberto(consulta.id);
    if (aberto) {
      return { checkout: aberto, consulta, novo: false };
    }

    const referencia = this.gerarReferencia();
    const { preferenciaId, checkoutUrl } = await this.gateway.criarCheckout({
      referencia,
      descricao: DESCRICAO_DO_ITEM,
      valor: consulta.valor,
      expiraEm: consulta.reservaExpiraEm,
    });

    // O adaptador confere de novo, sob bloqueio, que a consulta ainda pode ser
    // paga — a rotina de expiração pode ter agido enquanto o provedor respondia.
    const checkout = await this.pagamentos.registrarCheckout({
      consultaId: consulta.id,
      pacienteId,
      referencia,
      valorCentavos: consulta.valor.centavos,
      preferenciaId,
      checkoutUrl,
      agora,
    });

    return { checkout, consulta, novo: checkout.referencia === referencia };
  }
}

module.exports = { IniciarPagamento };
