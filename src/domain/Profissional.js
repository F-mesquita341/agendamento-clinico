'use strict';

/**
 * Profissional de saúde vinculado a uma clínica.
 *
 * Carrega o preço da consulta como objeto de valor `Dinheiro`, e não como
 * número solto: é ele que o adaptador congela na consulta no momento do
 * agendamento.
 */

const { Dinheiro } = require('./Dinheiro');
const { FORMA_DE_PAGAMENTO } = require('./formasDePagamento');

class Profissional {
  constructor({
    id,
    clinicaId,
    clinica,
    nome,
    registroConselho,
    especialidade,
    valorConsulta,
    ativo = true,
    aceitaPagamentoNoApp = true,
    aceitaPagarNaClinica = false,
    planos,
    proximoHorario,
  }) {
    this.id = id;
    this.clinicaId = clinicaId;
    // { id, nome, telefone, endereco, cidade, latitude, longitude } — tudo
    // menos id e nome pode faltar. É o contato que o paciente usa para chegar
    // à consulta ou ligar para a clínica.
    this.clinica = clinica ?? null;
    this.nome = nome;
    this.registroConselho = registroConselho;
    // { id, nome }
    this.especialidade = especialidade ?? null;
    this.valorConsulta =
      valorConsulta instanceof Dinheiro
        ? valorConsulta
        : Dinheiro.deCentavos(valorConsulta ?? 0);
    this.ativo = ativo;
    this.aceitaPagamentoNoApp = aceitaPagamentoNoApp;
    this.aceitaPagarNaClinica = aceitaPagarNaClinica;
    // [{ id, nome }] — ou undefined quando a leitura não os trouxe (a leitura
    // de consultas não traz). Undefined e lista vazia dizem coisas diferentes:
    // "não sei" e "não aceita plano nenhum".
    this.planos = planos;
    // { id, inicio } do horário livre mais cedo; null quando não há nenhum;
    // undefined quando a leitura não o calculou.
    this.proximoHorario = proximoHorario;
  }

  atende() {
    return this.ativo === true;
  }

  /**
   * As formas de pagamento que este profissional aceita, na ordem fixa
   * app → plano → clínica. "Plano" vale quando há ao menos um cadastrado.
   * Nunca sai vazia: o banco exige que todo profissional aceite ao menos o
   * aplicativo ou a clínica (migration 010).
   *
   * Sem a lista de planos lida, o plano fica de fora — não dá para afirmar
   * que o profissional aceita plano sem saber quais.
   */
  formasDePagamento() {
    const formas = [];
    if (this.aceitaPagamentoNoApp) formas.push(FORMA_DE_PAGAMENTO.APP);
    if (Array.isArray(this.planos) && this.planos.length > 0) {
      formas.push(FORMA_DE_PAGAMENTO.PLANO);
    }
    if (this.aceitaPagarNaClinica) formas.push(FORMA_DE_PAGAMENTO.CLINICA);
    return formas;
  }
}

module.exports = { Profissional, FORMA_DE_PAGAMENTO };
