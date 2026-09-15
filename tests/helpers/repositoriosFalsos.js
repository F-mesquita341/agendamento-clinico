'use strict';

/**
 * Repositórios em memória para testar os casos de uso sem banco.
 *
 * Implementam os mesmos contratos de `domain/repositorios` — inclusive o lock
 * otimista, simulado aqui com a mesma semântica do UPDATE ... WHERE versao:
 * se a versão apresentada não for a atual, a reserva não acontece e devolve
 * null. É isso que permite testar o caminho do 409 sem subir PostgreSQL.
 *
 * Regra ao mexer neste arquivo: o dublê só pode conhecer o que o adaptador
 * real conhece. Inventar aqui um campo que a entidade do domínio não tem faz
 * a suíte passar sobre código quebrado — foi exatamente o que aconteceu com o
 * valor da consulta, que chegou a ser lido de um `horario.valorCentavos`
 * existente apenas neste arquivo.
 */

const { Consulta, STATUS_CONSULTA } = require('../../src/domain/Consulta');
const { Horario, STATUS_HORARIO } = require('../../src/domain/Horario');
const { Dinheiro } = require('../../src/domain/Dinheiro');

/** Preço cobrado quando o teste não especifica outro. */
const PRECO_PADRAO = 15000;

class HorariosFalsos {
  /**
   * @param {Array} horarios
   * @param {Record<string, number>} precos valor em centavos por profissional —
   *        espelha `profissional.valor_consulta_centavos` no banco real.
   */
  constructor(horarios = [], precos = {}) {
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
        h.inicio >= de &&
        h.inicio <= ate
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

  async liberar(horarioId) {
    const horario = this.horarios.get(String(horarioId));
    if (!horario) return false;
    horario.status = STATUS_HORARIO.DISPONIVEL;
    horario.versao += 1;
    return true;
  }
}

class ConsultasFalsas {
  constructor() {
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

  async doPaciente(pacienteId) {
    return [...this.itens.values()].filter((c) => c.pertenceAo(pacienteId));
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
    if (!consulta) return null;
    consulta.status = STATUS_CONSULTA.CANCELADA;
    const h = this.horarioDaConsulta.get(String(consultaId));
    if (h) await this.horarios.liberar(h.id);
    return consulta;
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

module.exports = { criarRepositorios, umHorario, PRECO_PADRAO };
