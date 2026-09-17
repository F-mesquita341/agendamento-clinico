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

  /**
   * Devolve o horário à grade, incrementando a versão.
   *
   * Só age sobre horário `reservado`: o que a clínica bloqueou continua
   * bloqueado. O segundo argumento, opcional, permite rodar dentro de uma
   * transação já aberta — é como o cancelamento libera o horário junto com a
   * mudança de estado da consulta.
   *
   * @returns {Promise<boolean>} se o horário voltou para a grade.
   */
  async liberar(_horarioId, _executor) {
    naoImplementado('RepositorioDeHorarios.liberar');
  }
}

/**
 * Uma LEITURA de consulta é `{ consulta, horario, profissional }`.
 *
 * As telas do aplicativo mostram data, profissional e especialidade junto com
 * a consulta; devolver só a entidade obrigaria o cliente a uma requisição por
 * item da lista. A entidade continua sendo o que as regras de negócio usam —
 * a leitura é só a forma de apresentar.
 */
class RepositorioDeConsultas {
  /** @returns {Promise<import('./Consulta').Consulta|null>} */
  async porId(_id) {
    naoImplementado('RepositorioDeConsultas.porId');
  }

  /** @returns {Promise<{consulta, horario, profissional}|null>} */
  async leituraPorId(_id) {
    naoImplementado('RepositorioDeConsultas.leituraPorId');
  }

  /**
   * Página do histórico do paciente, da consulta mais próxima para a mais
   * antiga. Inclui as canceladas: elas são matéria-prima da análise de
   * absenteísmo, que é o problema central do trabalho.
   *
   * @param {{pacienteId: number, limite: number, deslocamento: number}} _filtros
   * @returns {Promise<{itens: Array, total: number}>} itens são leituras.
   */
  async doPaciente(_filtros) {
    naoImplementado('RepositorioDeConsultas.doPaciente');
  }

  /** Há consulta ativa do paciente que colida com este intervalo? */
  async existeAtivaNoIntervalo(_pacienteId, _inicio, _fim) {
    naoImplementado('RepositorioDeConsultas.existeAtivaNoIntervalo');
  }

  /**
   * Cancela e libera o horário, na mesma transação.
   *
   * Relê o estado sob bloqueio de linha antes de cancelar: entre a verificação
   * do caso de uso e esta escrita cabe outro cancelamento da mesma consulta.
   * Lança `NaoEncontrado` se a consulta não existir e o erro de estado do
   * domínio se ela não admitir mais cancelamento.
   */
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
