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
   * Três desfechos:
   *   - a consulta criada;
   *   - `null` quando a reserva não aconteceu porque outra pessoa chegou antes
   *     — versão desatualizada, ou a rede de segurança do banco recusando uma
   *     segunda consulta ativa no mesmo horário;
   *   - exceção de domínio quando o pedido é inadmissível por outra razão:
   *     profissional desativado, ou consulta sobreposta na agenda do paciente,
   *     recusada pela restrição `consulta_sem_sobreposicao` (migration 007).
   *
   * @param {object} dados
   * @param {number|string} dados.horarioId
   * @param {number} dados.versao versão lida pelo cliente
   * @param {number|string} dados.pacienteId
   * @param {Date} dados.reservaExpiraEm
   * @returns {Promise<import('./Consulta').Consulta|null>}
   */
  async reservarEAgendar(_dados) {
    naoImplementado('RepositorioDeHorarios.reservarEAgendar');
  }

  /**
   * Devolve o horário à grade, incrementando a versão.
   *
   * Só age sobre horário `reservado`: o que a clínica bloqueou continua
   * bloqueado. O segundo argumento é OBRIGATÓRIO: o cliente de uma transação já
   * aberta. Liberar um horário sozinho, fora da transação que muda a consulta e
   * sem auditoria, deixaria horário livre com consulta ativa — o estado que o
   * índice único depois recusa sem explicar.
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
   * Página do histórico do paciente, da consulta mais distante no futuro para a
   * mais antiga (`inicio` decrescente, id como desempate). Inclui as canceladas:
   * elas são matéria-prima da análise de absenteísmo, que é o problema central
   * do trabalho.
   *
   * Uma tela de "próxima consulta" NÃO deve usar o primeiro item desta lista —
   * ele é o compromisso mais longínquo, não o mais próximo.
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
   *
   * @returns {Promise<import('./Consulta').Consulta>} a consulta já cancelada —
   *          é ela que a resposta HTTP devolve, com valor e horário.
   */
  async cancelar(_consultaId) {
    naoImplementado('RepositorioDeConsultas.cancelar');
  }

  /**
   * Reservas que passaram do prazo sem pagamento, com as referências dos
   * checkouts delas — para a reconciliação perguntar ao provedor antes de
   * expirar. Leitura sem bloqueio: a decisão é refeita dentro da transação.
   *
   * @param {Date} _agora
   * @param {number} _limite quantas por rodada da rotina
   * @returns {Promise<Array<{consultaId: number, reservaExpiraEm: Date, referencias: string[]}>>}
   */
  async reservasVencidas(_agora, _limite) {
    naoImplementado('RepositorioDeConsultas.reservasVencidas');
  }

  /**
   * Expira a reserva, se ela ainda estiver vencida quando o bloqueio for obtido:
   * cancela com motivo `reserva_expirada`, devolve o horário, encerra o checkout
   * aberto e audita com ator `sistema` — tudo na mesma transação. Se um
   * pagamento a confirmou nesse meio-tempo, não faz nada.
   *
   * @returns {Promise<boolean>} se expirou
   */
  async expirarSeVencida(_consultaId, _agora) {
    naoImplementado('RepositorioDeConsultas.expirarSeVencida');
  }

  /**
   * Ids das consultas que merecem lembrete agora — confirmadas, ainda não
   * avisadas, começando nas próximas 24 horas.
   *
   * @returns {Promise<Array<number>>}
   */
  async aguardandoLembrete(_agora, _limite) {
    naoImplementado('RepositorioDeConsultas.aguardandoLembrete');
  }

  /**
   * Marca o lembrete como enviado, sob bloqueio, reconferindo
   * `Consulta.precisaDeLembrete`. É a marca que impede o reenvio a cada rodada.
   *
   * @returns {Promise<{consultaId: number, pacienteId: number, inicio: Date}|null>}
   *          null quando a consulta deixou de merecer entre a varredura e o
   *          bloqueio.
   */
  async reservarLembrete(_consultaId, _agora) {
    naoImplementado('RepositorioDeConsultas.reservarLembrete');
  }

  /** Desfaz a marca quando o envio falhou por motivo momentâneo. */
  async desmarcarLembrete(_consultaId) {
    naoImplementado('RepositorioDeConsultas.desmarcarLembrete');
  }

  /**
   * Audita o envio DEPOIS de ele ter acontecido — a marca é gravada antes, e
   * auditar junto dela diria "enviado" antes de enviar. Guarda a contagem de
   * aparelhos, nunca os tokens.
   */
  async registrarLembreteEnviado(_consultaId, _aparelhos) {
    naoImplementado('RepositorioDeConsultas.registrarLembreteEnviado');
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

/**
 * Aparelhos que recebem notificação push.
 *
 * Um DISPOSITIVO é `{ id, pacienteId, token, plataforma }`. O token é
 * identificador de aparelho — dado pessoal — e não sai daqui para log, resposta
 * de API nem auditoria.
 */
class RepositorioDeDispositivos {
  /**
   * Registra o aparelho. Se o token já existir, REATRIBUI ao paciente informado
   * em vez de criar outra linha: um aparelho que trocou de conta não pode
   * continuar recebendo o lembrete do dono anterior.
   *
   * @param {{pacienteId: number, token: string, plataforma: string}} _dados
   * @returns {Promise<void>}
   */
  async registrar(_dados) {
    naoImplementado('RepositorioDeDispositivos.registrar');
  }

  /**
   * Remove o token, mas só se ele pertencer a este paciente.
   *
   * @returns {Promise<boolean>} false quando não havia o que remover — a rota
   *          responde 404 nos dois casos, para ninguém descobrir token alheio
   *          por tentativa.
   */
  async revogar(_pacienteId, _token) {
    naoImplementado('RepositorioDeDispositivos.revogar');
  }

  /** @returns {Promise<Array<string>>} os tokens do paciente */
  async doPaciente(_pacienteId) {
    naoImplementado('RepositorioDeDispositivos.doPaciente');
  }

  /**
   * Apaga tokens que o provedor reportou como inexistentes — aplicativo
   * desinstalado, token expirado. Sem isso a tabela só cresce, e cada envio
   * carrega destinos mortos.
   *
   * @param {Array<string>} _tokens
   * @returns {Promise<number>} quantos foram apagados
   */
  async esquecer(_tokens) {
    naoImplementado('RepositorioDeDispositivos.esquecer');
  }
}

module.exports = {
  RepositorioDeHorarios,
  RepositorioDeConsultas,
  RepositorioDeEspecialidades,
  RepositorioDeProfissionais,
  RepositorioDePacientes,
  RepositorioDeDispositivos,
};
