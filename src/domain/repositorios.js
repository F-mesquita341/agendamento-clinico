'use strict';

/**
 * Contratos de persistência, declarados NO DOMÍNIO.
 *
 * Esta é a inversão de dependência do SOLID, e é o que faz a regra de
 * dependência de Martin (2019) valer na prática: o caso de uso conhece estas
 * classes abstratas; quem as implementa é `infra/db`, que fica na borda. A
 * seta de dependência aponta para dentro, nunca para fora.
 *
 * JavaScript não tem interface, então usamos classes abstratas que estouram se
 * alguém esquecer de implementar um método. É menos elegante que TypeScript,
 * mas o contrato fica explícito e verificável.
 */

function naoImplementado(metodo) {
  throw new Error(`${metodo} precisa ser implementado pelo adaptador concreto.`);
}

class RepositorioDeHorarios {
  /** @returns {Promise<import('./Horario').Horario|null>} */
  async porId(_id) {
    naoImplementado('RepositorioDeHorarios.porId');
  }

  /** @returns {Promise<Array>} horários disponíveis do profissional no período */
  async disponiveisDoProfissional(_profissionalId, _de, _ate) {
    naoImplementado('RepositorioDeHorarios.disponiveisDoProfissional');
  }

  /**
   * Reserva o horário e cria a consulta ATOMICAMENTE, comparando a versão.
   *
   * É um método único de propósito: a atomicidade entre reservar e agendar é
   * responsabilidade do adaptador de persistência — é ele que tem transação —,
   * e não do caso de uso, que só expressa a intenção.
   *
   * @returns {Promise<import('./Consulta').Consulta|null>} a consulta criada,
   *          ou `null` se a versão não conferia (outra pessoa chegou antes).
   */
  async reservarEAgendar(_dados) {
    naoImplementado('RepositorioDeHorarios.reservarEAgendar');
  }

  /** Devolve o horário à grade, incrementando a versão. */
  async liberar(_horarioId) {
    naoImplementado('RepositorioDeHorarios.liberar');
  }
}

class RepositorioDeConsultas {
  async porId(_id) {
    naoImplementado('RepositorioDeConsultas.porId');
  }

  async doPaciente(_pacienteId) {
    naoImplementado('RepositorioDeConsultas.doPaciente');
  }

  /** Há consulta ativa do paciente que colida com este intervalo? */
  async existeAtivaNoIntervalo(_pacienteId, _inicio, _fim) {
    naoImplementado('RepositorioDeConsultas.existeAtivaNoIntervalo');
  }

  /** Cancela e libera o horário, na mesma transação. */
  async cancelar(_consultaId) {
    naoImplementado('RepositorioDeConsultas.cancelar');
  }
}

module.exports = { RepositorioDeHorarios, RepositorioDeConsultas };
