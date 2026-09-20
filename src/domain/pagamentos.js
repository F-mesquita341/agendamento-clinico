'use strict';

/**
 * Contratos do pagamento, declarados no domínio — mesma inversão de dependência
 * de ./repositorios.js.
 *
 * O provedor (Mercado Pago) fica atrás de `GatewayDePagamento`: os casos de uso
 * não sabem que ele existe, e os testes trocam o provedor por um dublê sem rede.
 *
 * Um PAGAMENTO DO PROVEDOR, no formato que o adaptador entrega ao domínio:
 *
 *   { id, status, referencia, valorCentavos, moeda, modoReal }
 *
 * `status` já vem traduzido para os estados de ./Pagamento.js. `modoReal` é o
 * que o provedor diz sobre o modo da operação — registrado na auditoria, mas
 * NÃO usado como trava de sandbox: ver o comentário em ./Pagamento.js e a
 * verificação de conta em infra/pagamento/travaDeSandbox.js.
 */

function naoImplementado(metodo) {
  throw new Error(`${metodo} precisa ser implementado pelo adaptador concreto.`);
}

class GatewayDePagamento {
  /**
   * Cria um checkout no provedor. Nenhum dado do paciente é enviado.
   *
   * @param {{referencia: string, descricao: string,
   *          valor: import('./Dinheiro').Dinheiro, expiraEm: Date}} _dados
   * @returns {Promise<{preferenciaId: string, checkoutUrl: string}>}
   *          Lança `PagamentoIndisponivel` se o provedor não responder.
   */
  async criarCheckout(_dados) {
    naoImplementado('GatewayDePagamento.criarCheckout');
  }

  /**
   * Busca um pagamento pelo id do provedor — a fonte de verdade, e não o corpo
   * da notificação.
   *
   * @returns {Promise<object|null>} o pagamento, ou null se o provedor não o conhece
   */
  async consultarPagamento(_id) {
    naoImplementado('GatewayDePagamento.consultarPagamento');
  }

  /**
   * Pagamentos feitos com uma referência — usado pela reconciliação, para achar
   * um pagamento cuja notificação se perdeu.
   *
   * @returns {Promise<Array<object>>}
   */
  async pagamentosDaReferencia(_referencia) {
    naoImplementado('GatewayDePagamento.pagamentosDaReferencia');
  }

  /**
   * Quem é o dono da credencial — e, sobretudo, se é uma conta de TESTE.
   *
   * Está no contrato, e não escondido no adaptador, porque a restrição a
   * sandbox é uma exigência do trabalho, não um detalhe de implementação:
   * nenhum provedor pode ser ligado a esta API sem saber responder se o
   * dinheiro que ele move é de verdade. A API confere isto na subida e se
   * recusa a abrir a porta se a resposta não for "conta de teste".
   *
   * @returns {Promise<{id: string, apelido: string|null, siteId: string|null,
   *                    ehContaDeTeste: boolean}>}
   */
  async descreverConta() {
    naoImplementado('GatewayDePagamento.descreverConta');
  }
}

/**
 * Um CHECKOUT é `{ id, consultaId, referencia, status, valorCentavos,
 * preferenciaId, checkoutUrl }`.
 */
class RepositorioDePagamentos {
  /** @returns {Promise<object|null>} o checkout aberto da consulta, se houver */
  async checkoutAberto(_consultaId) {
    naoImplementado('RepositorioDePagamentos.checkoutAberto');
  }

  /**
   * Grava o checkout recém-criado no provedor, com auditoria. Se um pedido
   * simultâneo já gravou outro para a mesma consulta, devolve aquele — a
   * restrição de um checkout aberto por consulta é do banco.
   *
   * @param {{consultaId, pacienteId, referencia, valorCentavos, agora,
   *          preferenciaId, checkoutUrl}} _dados
   * @returns {Promise<object>} o checkout que vale
   */
  async registrarCheckout(_dados) {
    naoImplementado('RepositorioDePagamentos.registrarCheckout');
  }

  /**
   * Aplica um pagamento reportado pelo provedor: lê a consulta sob bloqueio,
   * pergunta ao domínio o que fazer (decidirEfeitoDoPagamento) e grava tudo na
   * mesma transação, com auditoria.
   *
   * @param {object} _pagamento pagamento do provedor
   * @param {{ator: 'webhook'|'sistema'}} _opcoes quem trouxe a notícia
   * @returns {Promise<{desfecho: string, anomalia: string|null}>}
   */
  async aplicarPagamento(_pagamento, _opcoes) {
    naoImplementado('RepositorioDePagamentos.aplicarPagamento');
  }
}

module.exports = { GatewayDePagamento, RepositorioDePagamentos };
