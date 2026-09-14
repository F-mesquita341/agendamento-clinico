'use strict';

/**
 * Horário de atendimento de um profissional.
 *
 * Entidade: dois horários com os mesmos dados são coisas diferentes se tiverem
 * ids diferentes. O que os identifica é o id, não o conteúdo.
 *
 * Carrega a coluna `versao`, que sustenta o lock otimista (FOWLER, 2006). Este
 * objeto NÃO executa a reserva — ele só sabe dizer se ela é admissível. Quem
 * reserva de fato é o adaptador de persistência, dentro de uma transação, onde
 * a comparação de versão pode ser atômica.
 */

const { HorarioIndisponivel, RegraDeNegocio } = require('./erros');

const STATUS = Object.freeze({
  DISPONIVEL: 'disponivel',
  RESERVADO: 'reservado',
  BLOQUEADO: 'bloqueado',
});

class Horario {
  constructor({ id, profissionalId, inicio, fim, status, versao }) {
    this.id = id;
    this.profissionalId = profissionalId;
    this.inicio = inicio instanceof Date ? inicio : new Date(inicio);
    this.fim = fim instanceof Date ? fim : new Date(fim);
    this.status = status ?? STATUS.DISPONIVEL;
    this.versao = versao ?? 0;

    if (!(this.fim > this.inicio)) {
      throw new RegraDeNegocio(
        'INTERVALO_INVALIDO',
        'O fim do horário precisa ser posterior ao início.'
      );
    }
  }

  estaDisponivel() {
    return this.status === STATUS.DISPONIVEL;
  }

  jaComecou(agora) {
    return this.inicio.getTime() <= agora.getTime();
  }

  pertenceAo(profissionalId) {
    return String(this.profissionalId) === String(profissionalId);
  }

  /** Duração em minutos — usada na listagem e nos lembretes. */
  duracaoEmMinutos() {
    return Math.round((this.fim - this.inicio) / 60_000);
  }

  /**
   * Lança se a reserva não for admissível.
   *
   * Estas verificações existem para produzir mensagens boas, não para garantir
   * exclusividade — entre esta checagem e a escrita existe uma janela em que
   * outra pessoa pode reservar. Quem garante é o lock otimista, na transação.
   */
  garantirQuePodeSerReservado(agora) {
    if (this.jaComecou(agora)) {
      throw new RegraDeNegocio(
        'HORARIO_NO_PASSADO',
        'Não é possível agendar um horário que já começou.'
      );
    }
    if (!this.estaDisponivel()) {
      throw new HorarioIndisponivel();
    }
  }
}

module.exports = { Horario, STATUS_HORARIO: STATUS };
