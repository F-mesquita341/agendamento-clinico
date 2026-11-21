'use strict';

/**
 * Caso de uso: pagar pelo aplicativo com Pix (versão 2, só com PIX_HABILITADO).
 *
 * Irmão de IniciarPagamento, com as mesmas garantias: só consulta do próprio
 * paciente, paga pelo aplicativo, aguardando pagamento e dentro do prazo
 * (`garantirQuePodeSerPagaPor`); um pagamento aberto por consulta; pedir de
 * novo devolve o MESMO Pix, sem criar outro no provedor.
 *
 * Se o aberto for da página do Mercado Pago, recusa: dois meios abertos
 * permitiriam pagar duas vezes.
 */

const crypto = require('node:crypto');
const { NaoEncontrado, PagamentoEmAndamento } = require('../domain/erros');
const { relogioDoSistema } = require('../domain/Relogio');

class IniciarPagamentoPix {
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

  /** @returns {Promise<{pix: object, consulta: object, novo: boolean}>} */
  async executar({ pacienteId, consultaId }) {
    const consulta = await this.consultas.porId(consultaId);
    if (!consulta) {
      throw new NaoEncontrado('Consulta', { feminino: true });
    }

    const agora = this.relogio.agora();
    consulta.garantirQuePodeSerPagaPor(pacienteId, agora);

    const aberto = await this.pagamentos.checkoutAberto(consulta.id);
    if (aberto) {
      if (aberto.meio !== 'pix') throw new PagamentoEmAndamento();
      return { pix: aberto, consulta, novo: false };
    }

    const referencia = this.gerarReferencia();
    const { pedidoId, copiaECola, qrBase64 } = await this.gateway.criarPix({
      referencia,
      valor: consulta.valor,
      expiraEm: consulta.reservaExpiraEm,
    });

    const pix = await this.pagamentos.registrarPix({
      consultaId: consulta.id,
      pacienteId,
      referencia,
      valorCentavos: consulta.valor.centavos,
      pedidoId,
      copiaECola,
      qrBase64,
      agora,
    });
    // Um checkout gravado no mesmo instante por outro pedido ganha a disputa.
    if (pix.meio !== 'pix') throw new PagamentoEmAndamento();
    return { pix, consulta, novo: pix.referencia === referencia };
  }
}

module.exports = { IniciarPagamentoPix };
