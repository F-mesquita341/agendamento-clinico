'use strict';

/**
 * Caso de uso: cancelar uma consulta e devolver o horário à grade.
 *
 * A consulta NÃO é apagada — muda de estado para 'cancelada'. O registro
 * precisa sobreviver: é matéria-prima da análise de absenteísmo, que é o
 * problema central investigado no trabalho.
 */

const { NaoEncontrado } = require('../domain/erros');
const { relogioDoSistema } = require('../domain/Relogio');

class CancelarConsulta {
  /**
   * @param {object} deps
   * @param {import('../domain/repositorios').RepositorioDeConsultas} deps.consultas
   * @param {import('../domain/repositorios').RepositorioDeHorarios} deps.horarios
   *        de onde vem o início da consulta, que mora no horário
   * @param {{agora: () => Date}} [deps.relogio]
   */
  constructor({ consultas, horarios, relogio = relogioDoSistema }) {
    this.consultas = consultas;
    this.horarios = horarios;
    this.relogio = relogio;
  }

  async executar({ pacienteId, consultaId }) {
    const consulta = await this.consultas.porId(consultaId);
    if (!consulta) {
      throw new NaoEncontrado('Consulta', { feminino: true });
    }

    const agora = this.relogio.agora();
    const horario = await this.horarios.porId(consulta.horarioId);

    // Lança AcessoNegado se for de outro paciente, ou RegraDeNegocio se o
    // estado ou o tempo não admitirem cancelamento.
    consulta.garantirQuePodeSerCanceladaPor(pacienteId, {
      agora,
      inicioDoHorario: horario?.inicio,
    });

    // O adaptador cancela e libera o horário na mesma transação — deixar as
    // duas escritas separadas abriria a chance de um horário ficar preso a
    // uma consulta já cancelada. O mesmo instante vai junto, para a checagem
    // sob bloqueio julgar o mesmo momento que esta.
    return this.consultas.cancelar(consulta.id, agora);
  }
}

module.exports = { CancelarConsulta };
