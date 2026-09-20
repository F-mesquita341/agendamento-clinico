'use strict';

/**
 * Mercado Pago em memória, para os testes — sem rede, sem conta.
 *
 * Estende o contrato do domínio, como os outros dublês: um método esquecido
 * aqui é acusado pelo teste de arquitetura, e não vira "is not a function" no
 * meio de um teste.
 *
 * Os pagamentos só existem quando o teste os cria com `pagar()` — é o
 * equivalente de o paciente concluir o checkout na página do provedor.
 */

const { GatewayDePagamento } = require('../../src/domain/pagamentos');
const { PagamentoIndisponivel } = require('../../src/domain/erros');

class GatewayFalso extends GatewayDePagamento {
  constructor() {
    super();
    this.limpar();
  }

  limpar() {
    this.checkouts = [];
    this.pagamentos = new Map();
    this.proximoId = 900_001;
    // Simula o provedor fora do ar.
    this.indisponivel = false;
    // Esconde os pagamentos da busca por referência — para testar o webhook
    // sozinho, sem que a reconciliação o encontre antes.
    this.ocultarNaBusca = false;
    // A trava de sandbox pergunta isto na subida da API.
    this.contaDeTeste = true;
  }

  verificarDisponivel() {
    if (this.indisponivel) throw new PagamentoIndisponivel();
  }

  async criarCheckout(dados) {
    this.verificarDisponivel();
    const preferenciaId = `pref-${this.checkouts.length + 1}`;
    this.checkouts.push({ ...dados, preferenciaId });
    return { preferenciaId, checkoutUrl: `https://sandbox.exemplo/checkout/${preferenciaId}` };
  }

  async consultarPagamento(id) {
    this.verificarDisponivel();
    return this.pagamentos.get(String(id)) ?? null;
  }

  async pagamentosDaReferencia(referencia) {
    this.verificarDisponivel();
    if (this.ocultarNaBusca) return [];
    return [...this.pagamentos.values()].filter((p) => p.referencia === referencia);
  }

  async descreverConta() {
    this.verificarDisponivel();
    return {
      id: '3699720609',
      apelido: 'TESTUSER0000000000',
      siteId: 'MLB',
      ehContaDeTeste: this.contaDeTeste,
    };
  }

  /** O paciente pagou no checkout desta referência. */
  pagar(referencia, { status = 'aprovado', valorCentavos, moeda = 'BRL', modoReal = false } = {}) {
    const checkout = this.checkouts.find((c) => c.referencia === referencia);
    const pagamento = {
      id: String(this.proximoId++),
      status,
      referencia,
      valorCentavos: valorCentavos ?? checkout.valor.centavos,
      moeda,
      modoReal,
    };
    this.pagamentos.set(pagamento.id, pagamento);
    return pagamento;
  }
}

module.exports = { GatewayFalso };
