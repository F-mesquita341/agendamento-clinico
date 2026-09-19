'use strict';

/**
 * O adaptador do Mercado Pago, com um `fetch` falso que grava o que seria
 * enviado. É aqui que se prova o que sai da API: o item genérico, a referência
 * aleatória, os prazos — e nenhum dado do paciente.
 */

const { GatewayMercadoPago } = require('../../src/infra/pagamento/GatewayMercadoPago');
const { Dinheiro } = require('../../src/domain/Dinheiro');

function fetchFalso(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, ...opcoes, corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
    const proxima = fila.shift();
    if (proxima instanceof Error) throw proxima;
    return {
      status: proxima.status,
      ok: proxima.status >= 200 && proxima.status < 300,
      json: async () => proxima.json,
    };
  };
  fn.chamadas = chamadas;
  return fn;
}

function gateway(respostas, opcoes = {}) {
  const fetch = fetchFalso(respostas);
  return {
    fetch,
    g: new GatewayMercadoPago({
      accessToken: 'TOKEN-DE-TESTE',
      urlDeNotificacao: 'https://api.exemplo/webhooks/mercadopago',
      fetch,
      ...opcoes,
    }),
  };
}

const CHECKOUT = {
  referencia: '4f1c2e3a-0000-4000-8000-000000000001',
  descricao: 'Consulta médica',
  valor: Dinheiro.deCentavos(18050),
  expiraEm: new Date('2026-10-01T13:15:00Z'),
};

describe('criarCheckout', () => {
  test('envia só o mínimo: item genérico, valor, referência e prazos', async () => {
    const { g, fetch } = gateway([
      { status: 201, json: { id: 'pref-1', init_point: 'https://mp/checkout/pref-1' } },
    ]);

    const checkout = await g.criarCheckout(CHECKOUT);

    expect(checkout).toEqual({ preferenciaId: 'pref-1', checkoutUrl: 'https://mp/checkout/pref-1' });
    const { url, method, headers, corpo } = fetch.chamadas[0];
    expect(method).toBe('POST');
    expect(url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect(headers.Authorization).toBe('Bearer TOKEN-DE-TESTE');
    expect(headers['X-Idempotency-Key']).toBe(CHECKOUT.referencia);
    expect(corpo).toEqual({
      items: [
        { id: 'consulta', title: 'Consulta médica', quantity: 1, currency_id: 'BRL', unit_price: 180.5 },
      ],
      external_reference: CHECKOUT.referencia,
      expires: true,
      expiration_date_to: '2026-10-01T13:15:00.000Z',
      notification_url: 'https://api.exemplo/webhooks/mercadopago',
    });
  });

  test('nenhum dado do paciente vai para o provedor', async () => {
    // A igualdade exata acima já garante isto; o teste explícito existe para o
    // requisito não depender de alguém ler a lista de campos com atenção.
    const { g, fetch } = gateway([{ status: 201, json: { id: 'p', init_point: 'u' } }]);
    await g.criarCheckout(CHECKOUT);

    const enviado = JSON.stringify(fetch.chamadas[0].corpo);
    expect(enviado).not.toMatch(/payer|email|nome|name|cpf|identification/i);
  });

  test('sem URL pública, o checkout é criado sem endereço de aviso', async () => {
    const { g, fetch } = gateway([{ status: 201, json: { id: 'p', init_point: 'u' } }], {
      urlDeNotificacao: null,
    });
    await g.criarCheckout(CHECKOUT);

    expect(fetch.chamadas[0].corpo).not.toHaveProperty('notification_url');
  });

  test('credencial recusada é erro de configuração, não indisponibilidade', async () => {
    const { g } = gateway([{ status: 401, json: {} }]);

    await expect(g.criarCheckout(CHECKOUT)).rejects.toThrow(/HTTP 401/);
    await expect(
      gateway([{ status: 401, json: {} }]).g.criarCheckout(CHECKOUT)
    ).rejects.not.toMatchObject({ codigo: 'PAGAMENTO_INDISPONIVEL' });
  });
});

describe('falhas do provedor viram PAGAMENTO_INDISPONIVEL (503)', () => {
  test.each([
    ['rede fora', new TypeError('fetch failed')],
    ['prazo estourado', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['erro 500', { status: 500, json: {} }],
    ['erro 503', { status: 503, json: {} }],
    ['limite de requisições', { status: 429, json: {} }],
  ])('%s', async (_rotulo, resposta) => {
    const { g } = gateway([resposta]);

    await expect(g.consultarPagamento('123')).rejects.toMatchObject({
      codigo: 'PAGAMENTO_INDISPONIVEL',
      status: 503,
    });
  });
});

describe('consultarPagamento', () => {
  test('traduz para o domínio e descarta os dados do pagador', async () => {
    const { g } = gateway([
      {
        status: 200,
        json: {
          id: 987654321,
          status: 'approved',
          external_reference: CHECKOUT.referencia,
          transaction_amount: 180.5,
          currency_id: 'BRL',
          live_mode: false,
          payer: { email: 'comprador@teste.com', identification: { number: '12345678909' } },
        },
      },
    ]);

    expect(await g.consultarPagamento('987654321')).toEqual({
      id: '987654321',
      status: 'aprovado',
      referencia: CHECKOUT.referencia,
      valorCentavos: 18050,
      moeda: 'BRL',
      modoReal: false,
    });
  });

  test('pagamento que o provedor não conhece é null', async () => {
    const { g } = gateway([{ status: 404, json: {} }]);

    expect(await g.consultarPagamento('1')).toBeNull();
  });

  test.each([
    ['approved', 'aprovado'],
    ['pending', 'pendente'],
    ['in_process', 'pendente'],
    ['rejected', 'recusado'],
    ['cancelled', 'recusado'],
    ['refunded', 'estornado'],
    ['charged_back', 'estornado'],
    ['um_status_novo', 'pendente'],
  ])('status %s vira %s', async (doProvedor, doDominio) => {
    const { g } = gateway([
      { status: 200, json: { id: 1, status: doProvedor, transaction_amount: 1, currency_id: 'BRL' } },
    ]);

    expect((await g.consultarPagamento('1')).status).toBe(doDominio);
  });

  test('live_mode verdadeiro é marcado como pagamento real', async () => {
    const { g } = gateway([
      { status: 200, json: { id: 1, status: 'approved', transaction_amount: 1, currency_id: 'BRL', live_mode: true } },
    ]);

    expect((await g.consultarPagamento('1')).modoReal).toBe(true);
  });
});

describe('pagamentosDaReferencia', () => {
  test('busca pela referência e traduz cada resultado', async () => {
    const { g, fetch } = gateway([
      {
        status: 200,
        json: { results: [{ id: 5, status: 'approved', external_reference: 'ref', transaction_amount: 250, currency_id: 'BRL' }] },
      },
    ]);

    const encontrados = await g.pagamentosDaReferencia('ref');

    expect(fetch.chamadas[0].url).toBe(
      'https://api.mercadopago.com/v1/payments/search?external_reference=ref'
    );
    expect(encontrados).toEqual([
      { id: '5', status: 'aprovado', referencia: 'ref', valorCentavos: 25000, moeda: 'BRL', modoReal: false },
    ]);
  });
});
