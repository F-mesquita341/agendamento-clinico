'use strict';

/**
 * Versão 2: a cobrança Pix no adaptador do Mercado Pago, com um `fetch` falso
 * que grava o que seria enviado. Prova o que sai da API: o pagador fictício,
 * o valor, a referência e o prazo — e nenhum dado do paciente. Que o Mercado
 * Pago aceita este corpo, quem prova é `npm run verificar:pix`, contra o
 * sandbox real (P0, 21/11).
 */

const { GatewayMercadoPago, GatewayNaoConfigurado } = require('../../src/infra/pagamento/GatewayMercadoPago');
const { Dinheiro } = require('../../src/domain/Dinheiro');
const { PagamentoIndisponivel } = require('../../src/domain/erros');

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

function gateway(respostas) {
  const fetch = fetchFalso(respostas);
  return { fetch, g: new GatewayMercadoPago({ accessToken: 'TOKEN-DE-TESTE', fetch }) };
}

const REFERENCIA = '4f1c2e3a-0000-4000-8000-000000000002';

function pix(minutos = 15) {
  return {
    referencia: REFERENCIA,
    valor: Dinheiro.deCentavos(25000),
    // Um segundo a menos que os minutos cheios: o adaptador arredonda para cima.
    expiraEm: new Date(Date.now() + minutos * 60_000 - 1000),
  };
}

const PEDIDO_CRIADO = {
  id: 'ORDTST01ABC',
  status: 'action_required',
  external_reference: REFERENCIA,
  transactions: {
    payments: [
      {
        id: 'PAY01XYZ',
        status: 'action_required',
        payment_method: { id: 'pix', type: 'bank_transfer', qr_code: '00020101-copia-e-cola', qr_code_base64: 'iVBORw0KGgo' },
      },
    ],
  },
};

describe('criarPix', () => {
  test('envia só o mínimo: pagador fictício, valor, referência e prazo', async () => {
    const { g, fetch } = gateway([{ status: 201, json: PEDIDO_CRIADO }]);

    const criado = await g.criarPix(pix());

    expect(criado).toEqual({ pedidoId: 'ORDTST01ABC', copiaECola: '00020101-copia-e-cola', qrBase64: 'iVBORw0KGgo' });
    const { url, method, headers, corpo } = fetch.chamadas[0];
    expect(method).toBe('POST');
    expect(url).toBe('https://api.mercadopago.com/v1/orders');
    expect(headers.Authorization).toBe('Bearer TOKEN-DE-TESTE');
    expect(headers['X-Idempotency-Key']).toBe(REFERENCIA);
    expect(corpo).toEqual({
      type: 'online',
      processing_mode: 'automatic',
      external_reference: REFERENCIA,
      total_amount: '250.00',
      payer: { email: 'test@testuser.com', first_name: 'APRO' },
      transactions: {
        payments: [
          { amount: '250.00', payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: 'PT15M' },
        ],
      },
    });
  });

  test('o pagador é sempre o fictício: nenhum dado do paciente cabe no corpo', async () => {
    const { g, fetch } = gateway([{ status: 201, json: PEDIDO_CRIADO }]);

    await g.criarPix(pix());

    // O caso de uso só entrega referência, valor e prazo; o resto é constante.
    expect(Object.keys(fetch.chamadas[0].corpo.payer).sort()).toEqual(['email', 'first_name']);
    expect(fetch.chamadas[0].corpo.payer).toEqual({ email: 'test@testuser.com', first_name: 'APRO' });
  });

  test('prazo já vencido ainda manda o mínimo de um minuto', async () => {
    const { g, fetch } = gateway([{ status: 201, json: PEDIDO_CRIADO }]);

    await g.criarPix({ ...pix(), expiraEm: new Date(Date.now() - 60_000) });

    expect(fetch.chamadas[0].corpo.transactions.payments[0].expiration_time).toBe('PT1M');
  });

  test('pedido sem o código para pagar é erro, e nada é devolvido', async () => {
    const semCodigo = JSON.parse(JSON.stringify(PEDIDO_CRIADO));
    delete semCodigo.transactions.payments[0].payment_method.qr_code;
    const { g } = gateway([{ status: 201, json: semCodigo }]);

    await expect(g.criarPix(pix())).rejects.toThrow(/sem o código/);
  });

  test('recusa do Mercado Pago (4xx) é erro de configuração', async () => {
    const { g } = gateway([{ status: 400, json: { errors: [{ code: 'invalid' }] } }]);

    await expect(g.criarPix(pix())).rejects.toThrow(/HTTP 400/);
  });

  test.each([[500], [429]])('HTTP %i vira pagamento indisponível', async (status) => {
    const { g } = gateway([{ status, json: {} }]);

    await expect(g.criarPix(pix())).rejects.toBeInstanceOf(PagamentoIndisponivel);
  });

  test('sem credencial configurada, o Pix também está indisponível', async () => {
    await expect(new GatewayNaoConfigurado().criarPix(pix())).rejects.toBeInstanceOf(PagamentoIndisponivel);
  });
});
