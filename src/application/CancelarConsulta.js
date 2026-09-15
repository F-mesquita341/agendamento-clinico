'use strict';

/**
 * Caso de uso: cancelar uma consulta e devolver o horário à grade.
 *
 * A consulta NÃO é apagada — muda de estado para 'cancelada'. O registro
 * precisa sobreviver: é matéria-prima da análise de absenteísmo, que é o
 * problema central investigado no trabalho.
 */

const { NaoEncontrado } = require('../domain/erros');

class CancelarConsulta {
  constructor({ consultas }) {
    this.consultas = consultas;
  }

  async executar({ pacienteId, consultaId }) {
    const consulta = await this.consultas.porId(consultaId);
    if (!consulta) {
      throw new NaoEncontrado('Consulta');
    }

    // Lança AcessoNegado se for de outro paciente, ou RegraDeNegocio se o
    // estado não admitir cancelamento.
    consulta.garantirQuePodeSerCanceladaPor(pacienteId);

    // O adaptador cancela e libera o horário na mesma transação — deixar as
    // duas escritas separadas abriria a chance de um horário ficar preso a
    // uma consulta já cancelada.
    return this.consultas.cancelar(consulta.id);
  }
}

module.exports = { CancelarConsulta };
