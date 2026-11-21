'use strict';

/**
 * Caso de uso: o aplicativo pergunta, enquanto mostra o QR, se o Pix já foi
 * pago (versão 2, só com PIX_HABILITADO).
 *
 * Não há regra nova aqui. É o mesmo caminho da reconciliação da expiração:
 * busca no provedor os pagamentos da referência e entrega cada um a
 * `aplicarPagamento`, que lê a consulta sob bloqueio e pergunta ao domínio se
 * confirma (estado, valor e moeda). Pedir de novo não muda nada: o domínio
 * reconhece a notícia repetida.
 *
 * Se o provedor estiver fora do ar, a consulta volta como está — o aplicativo
 * continua esperando e pergunta de novo; a reconciliação da expiração é a rede
 * de segurança.
 */

const { NaoEncontrado, AcessoNegado, PagamentoIndisponivel } = require('../domain/erros');

class ConferirPagamentoPix {
  constructor({ consultas, pagamentos, gateway }) {
    this.consultas = consultas;
    this.pagamentos = pagamentos;
    this.gateway = gateway;
  }

  /** @returns {Promise<object>} a leitura composta da consulta, depois da conferência */
  async executar({ pacienteId, consultaId }) {
    const consulta = await this.consultas.porId(consultaId);
    if (!consulta) {
      throw new NaoEncontrado('Consulta', { feminino: true });
    }
    if (!consulta.pertenceAo(pacienteId)) {
      throw new AcessoNegado('Esta consulta pertence a outro paciente.');
    }

    if (consulta.aguardandoPagamento()) {
      const aberto = await this.pagamentos.checkoutAberto(consulta.id);
      if (aberto && aberto.meio === 'pix') {
        let encontrados = [];
        try {
          encontrados = await this.gateway.pagamentosDaReferencia(aberto.referencia);
        } catch (erro) {
          if (!(erro instanceof PagamentoIndisponivel)) throw erro;
        }
        for (const pagamento of encontrados) {
          await this.pagamentos.aplicarPagamento(pagamento, { ator: 'sistema' });
        }
      }
    }

    return this.consultas.leituraPorId(consulta.id);
  }
}

module.exports = { ConferirPagamentoPix };
