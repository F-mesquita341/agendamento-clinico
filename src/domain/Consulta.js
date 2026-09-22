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

/**
 * Por que a consulta foi cancelada. Para a análise de absenteísmo, desistir e
 * abandonar o checkout são fenômenos diferentes — ver migration 008.
 */
const MOTIVO_CANCELAMENTO = Object.freeze({
  PACIENTE: 'paciente',
  RESERVA_EXPIRADA: 'reserva_expirada',
});

/**
 * Antecedência do lembrete. A Seção 3.2 do projeto aponta lembrete automatizado
 * entre as intervenções de maior efetividade contra o absenteísmo; 24 horas é a
 * antecedência que dá tempo de a pessoa remarcar ou avisar, liberando a vaga.
 */
const JANELA_DO_LEMBRETE_MS = 24 * 60 * 60 * 1000;

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
    motivoCancelamento = null,
  }) {
    this.id = id;
    this.pacienteId = pacienteId;
    this.horarioId = horarioId;
    this.status = status ?? STATUS.PENDENTE_PAGAMENTO;
    this.valor = valor instanceof Dinheiro ? valor : Dinheiro.deCentavos(valor ?? 0);
    this.reservaExpiraEm = reservaExpiraEm ? new Date(reservaExpiraEm) : null;
    this.lembreteEnviadoEm = lembreteEnviadoEm ? new Date(lembreteEnviadoEm) : null;
    this.criadoEm = criadoEm ? new Date(criadoEm) : null;
    this.motivoCancelamento = motivoCancelamento;
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

  /**
   * A consulta merece lembrete agora?
   *
   * Três condições, e as três precisam estar aqui — não metade aqui e metade
   * na consulta SQL da varredura. A rotina relê a consulta sob bloqueio antes
   * de marcar, e é esta função que ela pergunta de novo: entre a varredura e o
   * bloqueio, a consulta pode ter sido cancelada, ou já avisada por uma rodada
   * anterior.
   *
   * @param {Date} inicio começo da consulta — mora no horário, não aqui
   * @param {Date} agora
   */
  precisaDeLembrete(inicio, agora) {
    if (this.status !== STATUS.CONFIRMADA || this.lembreteEnviadoEm !== null) return false;
    if (!inicio || !agora) return false;

    const faltam = new Date(inicio).getTime() - agora.getTime();
    // Passada não se lembra, e o aviso é o das 24 horas: mais cedo que isso
    // seria avisar de coisa que a pessoa acabou de marcar.
    return faltam > 0 && faltam <= JANELA_DO_LEMBRETE_MS;
  }

  /**
   * O paciente pode abrir o checkout desta consulta?
   *
   * Só enquanto ela espera pagamento e a reserva não venceu. Depois do prazo, o
   * horário está para ser devolvido à grade — cobrar por ele seria vender o que
   * já não está garantido.
   */
  garantirQuePodeSerPagaPor(pacienteId, agora) {
    if (!this.pertenceAo(pacienteId)) {
      throw new AcessoNegado('Esta consulta pertence a outro paciente.');
    }
    if (!this.aguardandoPagamento()) {
      throw new RegraDeNegocio(
        'CONSULTA_NAO_PAGAVEL',
        this.status === STATUS.CONFIRMADA
          ? 'Esta consulta já está paga.'
          : 'Esta consulta não pode mais ser paga.'
      );
    }
    if (this.expirouAguardandoPagamento(agora)) {
      throw new RegraDeNegocio(
        'RESERVA_EXPIRADA',
        'O prazo para pagar esta reserva terminou. Escolha o horário de novo.'
      );
    }
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

module.exports = {
  Consulta,
  STATUS_CONSULTA: STATUS,
  MOTIVO_CANCELAMENTO,
  JANELA_DO_LEMBRETE_MS,
};
