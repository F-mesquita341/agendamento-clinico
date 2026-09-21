'use strict';

/**
 * Repositórios em memória para testar os casos de uso sem banco.
 *
 * Implementam os mesmos contratos de `domain/repositorios` — inclusive o lock
 * otimista, simulado aqui com a mesma semântica do UPDATE ... WHERE versao:
 * se a versão apresentada não for a atual, a reserva não acontece e devolve
 * null. É isso que permite testar o caminho do 409 sem subir PostgreSQL.
 *
 * Os três dublês ESTENDEM os contratos de `domain/repositorios`. Não é
 * formalidade: sem isso, um método que o contrato declara e o dublê esquece
 * some em silêncio — quem chamar recebe "is not a function", e o teste que
 * deveria acusar a falta vira um 500 sem explicação. Herdando, a própria classe
 * abstrata responde dizendo qual método falta.
 *
 * Regra ao mexer neste arquivo: o dublê só pode conhecer o que o adaptador
 * real conhece. Inventar aqui um campo que a entidade do domínio não tem faz
 * a suíte passar sobre código quebrado — foi exatamente o que aconteceu com o
 * valor da consulta, que chegou a ser lido de um `horario.valorCentavos`
 * existente apenas neste arquivo.
 */

const { Consulta, STATUS_CONSULTA, MOTIVO_CANCELAMENTO } = require('../../src/domain/Consulta');
const { Horario, STATUS_HORARIO } = require('../../src/domain/Horario');
const { Dinheiro } = require('../../src/domain/Dinheiro');
const { Paciente } = require('../../src/domain/Paciente');
const { NaoEncontrado, PacienteJaCadastrado } = require('../../src/domain/erros');
const {
  RepositorioDeHorarios,
  RepositorioDeConsultas,
  RepositorioDePacientes,
} = require('../../src/domain/repositorios');

/** Preço cobrado quando o teste não especifica outro. */
const PRECO_PADRAO = 15000;

class HorariosFalsos extends RepositorioDeHorarios {
  /**
   * @param {Array} horarios
   * @param {Record<string, number>} precos valor em centavos por profissional —
   *        espelha `profissional.valor_consulta_centavos` no banco real.
   */
  constructor(horarios = [], precos = {}) {
    super();
    this.horarios = new Map(horarios.map((h) => [String(h.id), h]));
    this.precos = precos;
    this.consultas = null; // ligado por criarRepositorios()
    this.proximoIdConsulta = 1;
  }

  /** Mesma leitura que o adaptador real faz, dentro da transação. */
  precoDoProfissional(profissionalId) {
    return this.precos[String(profissionalId)] ?? PRECO_PADRAO;
  }

  async porId(id) {
    return this.horarios.get(String(id)) ?? null;
  }

  async disponiveisDoProfissional(profissionalId, de, ate) {
    return [...this.horarios.values()].filter(
      (h) =>
        h.pertenceAo(profissionalId) &&
        h.estaDisponivel() &&
        // Intervalo semiaberto — `inicio >= de AND inicio < ate` —, idêntico
        // ao do adaptador PostgreSQL. Um dublê com limite fechado aceitaria um
        // horário começando exatamente em `ate` que o banco recusaria.
        h.inicio >= de &&
        h.inicio < ate
    );
  }

  async reservarEAgendar({ horarioId, versao, pacienteId, reservaExpiraEm }) {
    const horario = this.horarios.get(String(horarioId));

    // Exatamente a condição do UPDATE:
    //   WHERE id = $1 AND versao = $2 AND status = 'disponivel'
    if (!horario || horario.versao !== versao || !horario.estaDisponivel()) {
      return null;
    }

    horario.status = STATUS_HORARIO.RESERVADO;
    horario.versao += 1;

    const consulta = new Consulta({
      id: this.proximoIdConsulta++,
      pacienteId,
      horarioId: horario.id,
      status: STATUS_CONSULTA.PENDENTE_PAGAMENTO,
      // O adaptador é quem determina o valor, lendo o profissional.
      valor: Dinheiro.deCentavos(this.precoDoProfissional(horario.profissionalId)),
      reservaExpiraEm,
      criadoEm: new Date(),
    });

    this.consultas?.registrar(consulta, horario);
    return consulta;
  }

  // O segundo argumento existe no contrato (o cliente de uma transação já
  // aberta) e aqui não tem o que fazer: não há transação em memória.
  async liberar(horarioId, _executor) {
    const horario = this.horarios.get(String(horarioId));
    // Mesma cláusula do adaptador: `WHERE id = $1 AND status = 'reservado'`.
    // Horário bloqueado pela clínica não volta à grade por causa de um
    // cancelamento.
    if (!horario || horario.status !== STATUS_HORARIO.RESERVADO) return false;
    horario.status = STATUS_HORARIO.DISPONIVEL;
    horario.versao += 1;
    return true;
  }
}

class ConsultasFalsas extends RepositorioDeConsultas {
  constructor() {
    super();
    this.itens = new Map();
    this.horarioDaConsulta = new Map();
    this.horarios = null;
  }

  registrar(consulta, horario) {
    this.itens.set(String(consulta.id), consulta);
    this.horarioDaConsulta.set(String(consulta.id), horario);
  }

  async porId(id) {
    return this.itens.get(String(id)) ?? null;
  }

  /** Leitura composta, como a do adaptador — ver a nota sobre `profissional`. */
  async leituraPorId(id) {
    const consulta = this.itens.get(String(id));
    if (!consulta) return null;
    return {
      consulta,
      horario: this.horarioDaConsulta.get(String(id)) ?? null,
      profissional: null,
    };
  }

  /**
   * Mesma forma do adaptador: página de LEITURAS e total do conjunto.
   *
   * O `profissional` vem nulo porque este dublê não conhece profissionais — ele
   * sabe MENOS que o adaptador real, e não mais, que é o lado seguro. Quem
   * exercita a leitura composta são os testes de integração.
   */
  async doPaciente({ pacienteId, limite = 20, deslocamento = 0 }) {
    const dele = [...this.itens.values()]
      .filter((c) => c.pertenceAo(pacienteId))
      // Mesma ordenação do adaptador: `ORDER BY h.inicio DESC, c.id DESC`. Sem
      // ela, apagar o ORDER BY do SQL não quebraria teste nenhum.
      .sort((a, b) => {
        const inicioA = this.horarioDaConsulta.get(String(a.id))?.inicio ?? 0;
        const inicioB = this.horarioDaConsulta.get(String(b.id))?.inicio ?? 0;
        return inicioB - inicioA || b.id - a.id;
      });
    const pagina = dele.slice(deslocamento, deslocamento + limite);
    return {
      itens: pagina.map((consulta) => ({
        consulta,
        horario: this.horarioDaConsulta.get(String(consulta.id)) ?? null,
        profissional: null,
      })),
      total: dele.length,
    };
  }

  async existeAtivaNoIntervalo(pacienteId, inicio, fim) {
    return [...this.itens.values()].some((c) => {
      if (!c.pertenceAo(pacienteId) || !c.estaAtiva()) return false;
      const h = this.horarioDaConsulta.get(String(c.id));
      if (!h) return false;
      // Sobreposição: começa antes do outro terminar e termina depois de ele começar.
      return h.inicio < fim && h.fim > inicio;
    });
  }

  async cancelar(consultaId) {
    const consulta = this.itens.get(String(consultaId));
    // O adaptador real lê a consulta sob `FOR UPDATE` e deixa o domínio decidir
    // antes de escrever. Sem repetir isso aqui, o dublê aceitaria cancelar duas
    // vezes e um teste de caso de uso passaria sobre esse defeito.
    if (!consulta) {
      throw new NaoEncontrado('Consulta');
    }
    consulta.garantirQuePodeSerCancelada();
    await this.cancelarComMotivo(consulta, MOTIVO_CANCELAMENTO.PACIENTE);
    return consulta;
  }

  async reservasVencidas(agora, limite) {
    // O dublê não conhece checkouts: nenhuma referência para reconciliar.
    return [...this.itens.values()]
      .filter((c) => c.expirouAguardandoPagamento(agora))
      .sort((a, b) => a.reservaExpiraEm - b.reservaExpiraEm)
      .slice(0, limite)
      .map((c) => ({ consultaId: c.id, reservaExpiraEm: c.reservaExpiraEm, referencias: [] }));
  }

  async expirarSeVencida(consultaId, agora) {
    const consulta = this.itens.get(String(consultaId));
    // Mesma condição que o adaptador reavalia sob bloqueio.
    if (!consulta || !consulta.expirouAguardandoPagamento(agora)) return false;
    await this.cancelarComMotivo(consulta, MOTIVO_CANCELAMENTO.RESERVA_EXPIRADA);
    return true;
  }

  async aguardandoLembrete(agora, limite) {
    return [...this.itens.values()]
      .filter((c) => c.precisaDeLembrete(this.horarioDaConsulta.get(String(c.id))?.inicio, agora))
      .sort((a, b) => {
        const inicioA = this.horarioDaConsulta.get(String(a.id))?.inicio ?? 0;
        const inicioB = this.horarioDaConsulta.get(String(b.id))?.inicio ?? 0;
        return inicioA - inicioB;
      })
      .slice(0, limite)
      .map((c) => c.id);
  }

  async reservarLembrete(consultaId, agora) {
    const consulta = this.itens.get(String(consultaId));
    const inicio = this.horarioDaConsulta.get(String(consultaId))?.inicio;
    // Mesma condição que o adaptador reavalia sob bloqueio: entre a varredura e
    // este ponto, a consulta pode ter sido cancelada ou já avisada.
    if (!consulta || !consulta.precisaDeLembrete(inicio, agora)) return null;

    consulta.lembreteEnviadoEm = agora;
    return { consultaId: consulta.id, pacienteId: consulta.pacienteId, inicio };
  }

  async desmarcarLembrete(consultaId) {
    const consulta = this.itens.get(String(consultaId));
    if (consulta) consulta.lembreteEnviadoEm = null;
  }

  async registrarLembreteEnviado(consultaId, aparelhos) {
    this.lembretesAuditados ??= [];
    this.lembretesAuditados.push({ consultaId, aparelhos });
  }

  /** O banco exige motivo em toda consulta cancelada; o dublê também. */
  async cancelarComMotivo(consulta, motivo) {
    consulta.status = STATUS_CONSULTA.CANCELADA;
    consulta.motivoCancelamento = motivo;
    const h = this.horarioDaConsulta.get(String(consulta.id));
    if (h) await this.horarios.liberar(h.id, 'transação em memória');
  }
}

/** Monta o par já interligado, com os horários e os preços informados. */
function criarRepositorios(horarios = [], precos = {}) {
  const repoHorarios = new HorariosFalsos(horarios, precos);
  const repoConsultas = new ConsultasFalsas();
  repoHorarios.consultas = repoConsultas;
  repoConsultas.horarios = repoHorarios;
  return { horarios: repoHorarios, consultas: repoConsultas };
}

/**
 * Atalho para montar um horário de teste.
 *
 * Note que ele NÃO carrega preço: o `Horario` do domínio também não carrega.
 */
function umHorario({ id = 1, profissionalId = 10, inicio, duracaoMin = 30, versao = 0, status } = {}) {
  const comeco = inicio instanceof Date ? inicio : new Date(inicio);
  return new Horario({
    id,
    profissionalId,
    inicio: comeco,
    fim: new Date(comeco.getTime() + duracaoMin * 60_000),
    status,
    versao,
  });
}

/**
 * Pacientes em memória.
 *
 * Espelha o adaptador PostgreSQL em dois pontos que os testes precisam
 * enxergar: a unicidade de `firebaseUid` — que no banco é uma restrição
 * UNIQUE e aqui lança o mesmo erro de domínio — e a auditoria, registrada
 * com os nomes dos campos e nunca com os valores.
 */
class PacientesFalsos extends RepositorioDePacientes {
  constructor() {
    super();
    this.itens = new Map();
    this.auditoria = [];
    this.proximoId = 1;
  }

  async porFirebaseUid(firebaseUid) {
    return [...this.itens.values()].find((p) => p.firebaseUid === firebaseUid) ?? null;
  }

  async porId(id) {
    return this.itens.get(String(id)) ?? null;
  }

  async criar(dados) {
    if (await this.porFirebaseUid(dados.firebaseUid)) {
      throw new PacienteJaCadastrado();
    }
    const paciente = new Paciente({ id: this.proximoId++, ...dados });
    this.itens.set(String(paciente.id), paciente);
    this.auditoria.push({
      acao: 'paciente.cadastrado',
      entidadeId: paciente.id,
      detalhe: { consentimentoVersao: dados.consentimentoVersao },
    });
    return paciente;
  }

  async atualizar(id, campos) {
    const atual = this.itens.get(String(id));
    // Mesmo contrato do adaptador PostgreSQL: paciente inexistente é 404. Sem
    // isto, o dublê montaria um paciente a partir de `undefined` e o teste do
    // caso de uso passaria sobre um defeito.
    if (!atual) {
      throw new NaoEncontrado('Paciente');
    }
    // A mesma lista fechada do adaptador (COLUNA_DO_CAMPO): campo fora dela é
    // ignorado. Aceitar tudo aqui deixaria o dublê mais permissivo que o real
    // — um teste passaria mesmo se o filtro do caso de uso fosse removido.
    const permitidos = Object.fromEntries(
      Object.entries(campos).filter(([campo]) =>
        ['nome', 'telefone', 'dataNascimento'].includes(campo)
      )
    );
    // Sem campo permitido, o adaptador não roda UPDATE nem audita: devolve o
    // paciente como está.
    if (Object.keys(permitidos).length === 0) {
      return atual;
    }

    const atualizado = new Paciente({ ...atual, ...permitidos });
    this.itens.set(String(id), atualizado);
    this.auditoria.push({
      acao: 'paciente.atualizado',
      entidadeId: atual.id,
      detalhe: { campos: Object.keys(permitidos) },
    });
    return atualizado;
  }
}

module.exports = {
  criarRepositorios,
  umHorario,
  PRECO_PADRAO,
  HorariosFalsos,
  ConsultasFalsas,
  PacientesFalsos,
};
