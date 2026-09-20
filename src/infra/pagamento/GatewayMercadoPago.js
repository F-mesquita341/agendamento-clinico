'use strict';

/**
 * Adaptador do Mercado Pago — Checkout Pro, em sandbox.
 *
 * Três chamadas, feitas com `fetch` em vez do SDK oficial: uma dependência a
 * menos, prazo e erros sob controle, e um dublê trivial nos testes.
 *
 *   criar checkout        POST /checkout/preferences
 *   consultar pagamento   GET  /v1/payments/:id
 *   buscar por referência GET  /v1/payments/search?external_reference=
 *
 * O que vai para o Mercado Pago é o mínimo (LGPD, Art. 6º, III): um item de
 * descrição genérica, o valor, uma referência aleatória e os prazos. Nenhum
 * dado do paciente — nem e-mail, nem nome. O que volta dele também é filtrado:
 * só id, status, referência, valor, moeda e se é pagamento real; os dados do
 * pagador que a resposta traz são descartados aqui mesmo.
 */

const { GatewayDePagamento } = require('../../domain/pagamentos');
const { PagamentoIndisponivel } = require('../../domain/erros');
const { STATUS_PAGAMENTO } = require('../../domain/Pagamento');

const BASE = 'https://api.mercadopago.com';
const PRAZO_MS = 10_000;

/**
 * Status do Mercado Pago → status do domínio. Qualquer status desconhecido
 * cai em `pendente`, que nunca confirma consulta: na dúvida, não se libera
 * nada.
 */
const STATUS_DO_MERCADO_PAGO = Object.freeze({
  approved: STATUS_PAGAMENTO.APROVADO,
  authorized: STATUS_PAGAMENTO.PENDENTE,
  pending: STATUS_PAGAMENTO.PENDENTE,
  in_process: STATUS_PAGAMENTO.PENDENTE,
  in_mediation: STATUS_PAGAMENTO.PENDENTE,
  rejected: STATUS_PAGAMENTO.RECUSADO,
  cancelled: STATUS_PAGAMENTO.RECUSADO,
  refunded: STATUS_PAGAMENTO.ESTORNADO,
  charged_back: STATUS_PAGAMENTO.ESTORNADO,
});

function paraPagamento(json) {
  return {
    id: String(json.id),
    status: STATUS_DO_MERCADO_PAGO[json.status] ?? STATUS_PAGAMENTO.PENDENTE,
    referencia: json.external_reference ?? null,
    // O Mercado Pago fala em reais com casas decimais; o domínio, em centavos
    // inteiros. O arredondamento absorve o erro de ponto flutuante (180.5 * 100).
    valorCentavos: Math.round(Number(json.transaction_amount) * 100),
    moeda: json.currency_id,
    modoReal: json.live_mode === true,
  };
}

class GatewayMercadoPago extends GatewayDePagamento {
  /**
   * @param {object} opcoes
   * @param {string} opcoes.accessToken credencial da conta de teste vendedora
   * @param {string|null} opcoes.urlDeNotificacao para onde o Mercado Pago avisa;
   *        sem URL pública (desenvolvimento local), o checkout é criado sem aviso
   * @param {Function} [opcoes.fetch] injetável nos testes
   */
  constructor({ accessToken, urlDeNotificacao = null, fetch = globalThis.fetch }) {
    super();
    this.accessToken = accessToken;
    this.urlDeNotificacao = urlDeNotificacao;
    this.fetch = fetch;
  }

  async requisitar(metodo, caminho, { corpo, idempotencia } = {}) {
    let resposta;
    try {
      resposta = await this.fetch(`${BASE}${caminho}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(corpo ? { 'Content-Type': 'application/json' } : {}),
          // Repetir a mesma criação com a mesma chave não cria dois checkouts.
          ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}),
        },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(PRAZO_MS),
      });
    } catch (erro) {
      // Rede fora, DNS, prazo estourado: não é defeito nosso nem do pedido.
      console.warn(`Mercado Pago não respondeu a ${metodo} ${caminho.split('?')[0]}: ${erro.name}`);
      throw new PagamentoIndisponivel();
    }

    if (resposta.status >= 500 || resposta.status === 429) {
      console.warn(`Mercado Pago respondeu ${resposta.status} a ${metodo} ${caminho.split('?')[0]}`);
      throw new PagamentoIndisponivel();
    }
    return resposta;
  }

  async criarCheckout({ referencia, descricao, valor, expiraEm }) {
    const corpo = {
      items: [
        {
          id: 'consulta',
          title: descricao,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: valor.centavos / 100,
        },
      ],
      external_reference: referencia,
      // O checkout expira junto com a reserva: depois do prazo, o horário está
      // para voltar à grade, e pagar por ele seria comprar o que não existe.
      expires: true,
      expiration_date_to: expiraEm.toISOString(),
      ...(this.urlDeNotificacao ? { notification_url: this.urlDeNotificacao } : {}),
    };

    const resposta = await this.requisitar('POST', '/checkout/preferences', {
      corpo,
      idempotencia: referencia,
    });
    if (!resposta.ok) {
      // 4xx aqui é credencial errada ou corpo que o Mercado Pago não aceita:
      // defeito de configuração, que precisa aparecer como erro interno.
      throw new Error(`Mercado Pago recusou a criação do checkout: HTTP ${resposta.status}`);
    }

    const json = await resposta.json();
    const checkoutUrl = json.init_point ?? json.sandbox_init_point;
    if (!checkoutUrl) {
      // Sem endereço não há pagamento possível. Falhar aqui evita gravar um
      // checkout "aberto" que ninguém consegue pagar e que ainda bloqueia
      // novas tentativas até a reserva expirar.
      throw new Error('Mercado Pago criou o checkout sem endereço de pagamento.');
    }
    return { preferenciaId: String(json.id), checkoutUrl };
  }

  async consultarPagamento(id) {
    const resposta = await this.requisitar('GET', `/v1/payments/${encodeURIComponent(id)}`);
    if (resposta.status === 404) return null;
    if (!resposta.ok) {
      throw new Error(`Mercado Pago recusou a consulta do pagamento: HTTP ${resposta.status}`);
    }
    return paraPagamento(await resposta.json());
  }

  async pagamentosDaReferencia(referencia) {
    const resposta = await this.requisitar(
      'GET',
      `/v1/payments/search?external_reference=${encodeURIComponent(referencia)}`
    );
    if (!resposta.ok) {
      throw new Error(`Mercado Pago recusou a busca de pagamentos: HTTP ${resposta.status}`);
    }
    const json = await resposta.json();
    return (json.results ?? []).map(paraPagamento);
  }

  /**
   * De quem é a credencial. `GET /users/me` devolve a conta inteira — inclusive
   * e-mail, nome e documento do titular —, e nada disso é lido: só o que a
   * trava de sandbox precisa saber.
   *
   * O sinal de conta de teste é a tag `test_user`, que o próprio Mercado Pago
   * põe nas contas criadas pelo painel de contas de teste. É o que resta de
   * confiável depois de `live_mode` se mostrar inútil para isso.
   */
  async descreverConta() {
    const resposta = await this.requisitar('GET', '/users/me');
    if (!resposta.ok) {
      throw new Error(`Mercado Pago recusou a identificação da conta: HTTP ${resposta.status}`);
    }
    const json = await resposta.json();
    return {
      id: String(json.id),
      apelido: json.nickname ?? null,
      siteId: json.site_id ?? null,
      ehContaDeTeste: Array.isArray(json.tags) && json.tags.includes('test_user'),
    };
  }
}

/**
 * Sem credencial configurada: toda operação responde que o pagamento está
 * indisponível. Permite subir a API em desenvolvimento sem conta no Mercado
 * Pago — em produção, config.js recusa a subida.
 */
class GatewayNaoConfigurado extends GatewayDePagamento {
  async criarCheckout() {
    throw new PagamentoIndisponivel('O pagamento não está configurado neste ambiente.');
  }

  async consultarPagamento() {
    throw new PagamentoIndisponivel('O pagamento não está configurado neste ambiente.');
  }

  async pagamentosDaReferencia() {
    throw new PagamentoIndisponivel('O pagamento não está configurado neste ambiente.');
  }

  async descreverConta() {
    throw new PagamentoIndisponivel('O pagamento não está configurado neste ambiente.');
  }
}

module.exports = { GatewayMercadoPago, GatewayNaoConfigurado, STATUS_DO_MERCADO_PAGO };
