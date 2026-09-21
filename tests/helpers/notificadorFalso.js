'use strict';

/**
 * Firebase Cloud Messaging em memória, para os testes — sem rede, sem
 * credencial.
 *
 * Estende o contrato do domínio, como os outros dublês: um método esquecido
 * aqui é acusado pelo teste de arquitetura, e não vira "is not a function" no
 * meio de um teste.
 */

const { ServicoDeNotificacao } = require('../../src/domain/notificacoes');

class NotificadorFalso extends ServicoDeNotificacao {
  constructor() {
    super();
    this.limpar();
  }

  limpar() {
    this.enviados = [];
    // Tokens que o "provedor" vai reportar como inexistentes.
    this.mortos = new Set();
    // Simula o provedor fora do ar.
    this.indisponivel = false;
  }

  async enviar({ tokens, titulo, corpo, dados, expiraEm }) {
    if (this.indisponivel) {
      throw new Error('Firebase Cloud Messaging indisponível');
    }
    this.enviados.push({ tokens: [...tokens], titulo, corpo, dados, expiraEm });

    const invalidos = tokens.filter((t) => this.mortos.has(t));
    return { entregues: tokens.length - invalidos.length, invalidos };
  }

  /** Quantas mensagens saíram — uma por paciente avisado, não por aparelho. */
  get quantidade() {
    return this.enviados.length;
  }
}

module.exports = { NotificadorFalso };
