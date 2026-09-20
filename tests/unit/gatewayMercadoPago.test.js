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

  test('checkout criado sem endereço de pagamento falha na hora', async () => {
    // Gravar um checkout "aberto" sem URL bloquearia novas tentativas até a
    // reserva expirar, e o paciente receberia uma tela de pagamento vazia.
    const { g } = gateway([{ status: 201, json: { id: 'pref-9' } }]);

    await expect(g.criarCheckout(CHECKOUT)).rejects.toThrow(/sem endereço de pagamento/);
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

describe('descreverConta', () => {
  // O payload é o que o Mercado Pago devolveu de verdade para a conta de teste
  // do trabalho, reduzido aos campos que importam. Os demais — e-mail, nome,
  // documento do titular — existem na resposta e não são lidos.
  const RESPOSTA = {
    id: 3699720609,
    nickname: 'TESTUSER3774910712453320476',
    site_id: 'MLB',
    tags: ['user_product_seller', 'test_user', 'normal'],
    email: 'test_user_3774910712@testuser.com',
    first_name: 'Test',
  };

  test('a tag test_user identifica a conta de teste', async () => {
    const { g, fetch } = gateway([{ status: 200, json: RESPOSTA }]);

    expect(await g.descreverConta()).toEqual({
      id: '3699720609',
      apelido: 'TESTUSER3774910712453320476',
      siteId: 'MLB',
      ehContaDeTeste: true,
    });
    expect(fetch.chamadas[0].url).toBe('https://api.mercadopago.com/users/me');
  });

  test('nenhum dado do titular sai do adaptador', async () => {
    // A igualdade exata acima já garante; este teste existe para o requisito
    // não depender de alguém reparar que `email` ficou de fora.
    const { g } = gateway([{ status: 200, json: RESPOSTA }]);

    expect(JSON.stringify(await g.descreverConta())).not.toMatch(/email|first_name|testuser\.com/i);
  });

  test('conta sem a tag test_user não é conta de teste', async () => {
    const { g } = gateway([
      { status: 200, json: { ...RESPOSTA, tags: ['normal', 'user_product_seller'] } },
    ]);

    expect((await g.descreverConta()).ehContaDeTeste).toBe(false);
  });

  test('resposta sem tags nenhuma não é conta de teste', async () => {
    // Na dúvida, não é de teste: a trava falha fechada.
    const { g } = gateway([{ status: 200, json: { id: 1, nickname: 'x', site_id: 'MLB' } }]);

    expect((await g.descreverConta()).ehContaDeTeste).toBe(false);
  });

  test('credencial recusada não vira "conta comum": estoura', async () => {
    const { g } = gateway([{ status: 401, json: {} }]);

    await expect(g.descreverConta()).rejects.toThrow(/HTTP 401/);
  });

  test('provedor fora do ar vira PAGAMENTO_INDISPONIVEL', async () => {
    const { g } = gateway([{ status: 500, json: {} }]);

    await expect(g.descreverConta()).rejects.toMatchObject({ codigo: 'PAGAMENTO_INDISPONIVEL' });
  });
});

describe('GatewayNaoConfigurado', () => {
  // Sem credencial, a API sobe e a rota de pagamento responde 503. Se um método
  // do contrato ficar de fora daqui, o que estoura é "precisa ser implementado
  // pelo adaptador concreto" — erro interno, e não a indisponibilidade que o
  // aplicativo sabe tratar. Foi por um esquecimento desse tipo que o teste de
  // conformidade dos dublês nasceu, na Etapa 4.
  const { GatewayNaoConfigurado } = require('../../src/infra/pagamento/GatewayMercadoPago');
  const { GatewayDePagamento } = require('../../src/domain/pagamentos');

  const metodos = Object.getOwnPropertyNames(GatewayDePagamento.prototype).filter(
    (nome) => nome !== 'constructor'
  );

  test('implementa todos os métodos do contrato', () => {
    const faltando = metodos.filter(
      (nome) => !Object.prototype.hasOwnProperty.call(GatewayNaoConfigurado.prototype, nome)
    );

    expect(faltando).toEqual([]);
  });

  test.each(metodos)('%s responde PAGAMENTO_INDISPONIVEL', async (metodo) => {
    await expect(new GatewayNaoConfigurado()[metodo]('x')).rejects.toMatchObject({
      codigo: 'PAGAMENTO_INDISPONIVEL',
      status: 503,
    });
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
