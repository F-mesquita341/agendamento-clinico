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
   * O VALOR da consulta é obrigação do adaptador: ele lê
   * `profissional.valor_consulta_centavos` dentro da mesma transação e grava
   * em `consulta.valor_centavos`. O caso de uso não informa preço — se
   * informasse, precisaria ter lido o profissional antes, fora da transação,
   * e um reajuste no intervalo produziria cobrança divergente da combinada.
   *
   * @param {object} dados
   * @param {number|string} dados.horarioId
   * @param {number} dados.versao versão lida pelo cliente
   * @param {number|string} dados.pacienteId
   * @param {Date} dados.reservaExpiraEm
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

class RepositorioDeEspecialidades {
  /** @returns {Promise<Array<{id: number, nome: string}>>} */
  async listar() {
    naoImplementado('RepositorioDeEspecialidades.listar');
  }
}

class RepositorioDeProfissionais {
  /**
   * Busca paginada, filtrando por especialidade e por trecho do nome.
   *
   * @param {object} filtros
   * @param {number} [filtros.especialidadeId]
   * @param {string} [filtros.termo] trecho do nome, sem diferenciar acento
   * @param {number} filtros.limite
   * @param {number} filtros.deslocamento
   * @returns {Promise<{itens: Array, total: number}>}
   */
  async listar(_filtros) {
    naoImplementado('RepositorioDeProfissionais.listar');
  }

  /** @returns {Promise<import('./Profissional').Profissional|null>} */
  async porId(_id) {
    naoImplementado('RepositorioDeProfissionais.porId');
  }
}

class RepositorioDePacientes {
  /** @returns {Promise<import('./Paciente').Paciente|null>} */
  async porFirebaseUid(_firebaseUid) {
    naoImplementado('RepositorioDePacientes.porFirebaseUid');
  }

  /** @returns {Promise<import('./Paciente').Paciente|null>} */
  async porId(_id) {
    naoImplementado('RepositorioDePacientes.porId');
  }

  /**
   * Cria o paciente e registra a operação em auditoria, na mesma transação.
   *
   * Lança `PacienteJaCadastrado` se o `firebaseUid` já existir. A verificação
   * prévia do caso de uso não basta: duas requisições simultâneas passam por
   * ela juntas, e só a restrição de unicidade do banco decide qual vence.
   *
   * @returns {Promise<import('./Paciente').Paciente>}
   */
  async criar(_dados) {
    naoImplementado('RepositorioDePacientes.criar');
  }

  /**
   * Atualiza apenas os campos informados e registra em auditoria os NOMES dos
   * campos alterados — nunca os valores.
   *
   * Lança `NaoEncontrado` se o paciente não existir. O caso de uso confia nisso
   * e não faz leitura prévia.
   *
   * @param {number} _id
   * @param {{nome?: string, telefone?: string|null, dataNascimento?: string|null}} _campos
   * @returns {Promise<import('./Paciente').Paciente>}
   */
  async atualizar(_id, _campos) {
    naoImplementado('RepositorioDePacientes.atualizar');
  }
}

module.exports = {
  RepositorioDeHorarios,
  RepositorioDeConsultas,
  RepositorioDeEspecialidades,
  RepositorioDeProfissionais,
  RepositorioDePacientes,
};
