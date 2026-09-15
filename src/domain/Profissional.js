'use strict';

/**
 * Profissional de saúde vinculado a uma clínica.
 *
 * Carrega o preço da consulta como objeto de valor `Dinheiro`, e não como
 * número solto: é ele que o adaptador congela na consulta no momento do
 * agendamento.
 */

const { Dinheiro } = require('./Dinheiro');

class Profissional {
  constructor({
    id,
    clinicaId,
    nome,
    registroConselho,
    especialidade,
    valorConsulta,
    ativo = true,
  }) {
    this.id = id;
    this.clinicaId = clinicaId;
    this.nome = nome;
    this.registroConselho = registroConselho;
    // { id, nome }
    this.especialidade = especialidade ?? null;
    this.valorConsulta =
      valorConsulta instanceof Dinheiro
        ? valorConsulta
        : Dinheiro.deCentavos(valorConsulta ?? 0);
    this.ativo = ativo;
  }

  atende() {
    return this.ativo === true;
  }
}

module.exports = { Profissional };
