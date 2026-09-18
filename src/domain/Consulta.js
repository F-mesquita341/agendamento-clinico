'use strict';

/**
 * Consulta agendada — a entidade central do domínio.
 *
 * Ciclo de vida:
 *
 *   pendente_pagamento ──pagou──▶ confirmada ──aconteceu──▶ realizada
 *          │                          │                └──faltou──▶ nao_compareceu
 *          │                          │
 *          └──expirou/cancelou────────┴──────────────────▶ cancelada
 *
 * Só 'cancelada' devolve o horário para a grade. É por isso que o índice único
 * do banco é parcial: uma consulta cancelada continua existindo, para histórico
 * e para a análise de absenteísmo, sem bloquear o horário.
 */

const { AcessoNegado, RegraDeNegocio } = require('./erros');
const { Dinheiro } = require('./Dinheiro');

const STATUS = Object.freeze({
  PENDENTE_PAGAMENTO: 'pendente_pagamento',
  CONFIRMADA: 'confirmada',
  CANCELADA: 'cancelada',
  REALIZADA: 'realizada',
  NAO_COMPARECEU: 'nao_compareceu',
});

const CANCELAVEIS = Object.freeze([
  STATUS.PENDENTE_PAGAMENTO,
  STATUS.CONFIRMADA,
]);

class Consulta {
  constructor({
    id,
    pacienteId,
    horarioId,
    status,
    valor,
    reservaExpiraEm,
    lembreteEnviadoEm,
    criadoEm,
  }) {
    this.id = id;
    this.pacienteId = pacienteId;
    this.horarioId = horarioId;
    this.status = status ?? STATUS.PENDENTE_PAGAMENTO;
    this.valor = valor instanceof Dinheiro ? valor : Dinheiro.deCentavos(valor ?? 0);
    this.reservaExpiraEm = reservaExpiraEm ? new Date(reservaExpiraEm) : null;
    this.lembreteEnviadoEm = lembreteEnviadoEm ? new Date(lembreteEnviadoEm) : null;
    this.criadoEm = criadoEm ? new Date(criadoEm) : null;
  }

  /** Ativa = ocupa o horário. Tudo menos cancelada. */
  estaAtiva() {
    return this.status !== STATUS.CANCELADA;
  }

  pertenceAo(pacienteId) {
    return String(this.pacienteId) === String(pacienteId);
  }

  aguardandoPagamento() {
    return this.status === STATUS.PENDENTE_PAGAMENTO;
  }

  /**
   * Reserva não paga que passou do prazo. A rotina de expiração usa isto para
   * devolver o horário à grade — sem ela, um checkout abandonado inutilizaria
   * o horário até a data da consulta.
   */
  expirouAguardandoPagamento(agora) {
    return (
      this.aguardandoPagamento() &&
      this.reservaExpiraEm !== null &&
      this.reservaExpiraEm.getTime() <= agora.getTime()
    );
  }

  precisaDeLembrete() {
    return this.status === STATUS.CONFIRMADA && this.lembreteEnviadoEm === null;
  }

  garantirQuePodeSerCanceladaPor(pacienteId) {
    if (!this.pertenceAo(pacienteId)) {
      throw new AcessoNegado('Esta consulta pertence a outro paciente.');
    }
    this.garantirQuePodeSerCancelada();
  }

  /**
   * Só o estado, sem a questão do dono.
   *
   * O adaptador de persistência repete esta verificação sob bloqueio de linha,
   * porque entre a checagem do caso de uso e a escrita cabe outro cancelamento
   * da mesma consulta — dedo duplo no botão, aplicativo reenviando depois de
   * uma queda de rede. Separar evita que a mensagem certa para cada estado
   * exista em dois lugares.
   */
  garantirQuePodeSerCancelada() {
    if (this.status === STATUS.CANCELADA) {
      throw new RegraDeNegocio(
        'CONSULTA_JA_CANCELADA',
        'Esta consulta já foi cancelada.'
      );
    }
    if (!CANCELAVEIS.includes(this.status)) {
      throw new RegraDeNegocio(
        'CONSULTA_NAO_CANCELAVEL',
        'Consultas já realizadas não podem ser canceladas.'
      );
    }
  }
}

module.exports = { Consulta, STATUS_CONSULTA: STATUS };
