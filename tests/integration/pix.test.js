'use strict';

/**
 * Versão 2: pagar com Pix, contra o PostgreSQL real e com o Mercado Pago num
 * dublê (tests/helpers/gatewayFalso.js).
 *
 * Dois servidores: um com PIX_HABILITADO ligado e outro desligado — este
 * segundo prova que, desligado, a API responde como antes do Pix.
 */

const request = require('supertest');
const { iniciar, parar, fechar } = require('../helpers/servidor');
const { semear, semearPacientes } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { GatewayFalso } = require('../helpers/gatewayFalso');
const { consultar } = require('../../src/infra/db/pool');
const { RepositorioDeConsultasPg } = require('../../src/infra/db/RepositorioDeConsultasPg');
const { RepositorioDePagamentosPg } = require('../../src/infra/db/RepositorioDePagamentosPg');
const { ExpirarReservasVencidas } = require('../../src/application/ExpirarReservasVencidas');

const comoA = { Authorization: `Bearer ${tokenDe('uid-paciente-a', 'paciente.a@example.com')}` };
const comoB = { Authorization: `Bearer ${tokenDe('uid-paciente-b', 'paciente.b@example.com')}` };

const gateway = new GatewayFalso();
const expirar = new ExpirarReservasVencidas({
  consultas: new RepositorioDeConsultasPg(),
  pagamentos: new RepositorioDePagamentosPg(),
  gateway,
});

let comPix;
let semPix;
let dados;
let pacientes;

beforeAll(async () => {
  comPix = await iniciar({ gateway, pixHabilitado: true });
  semPix = await iniciar({ gateway, pixHabilitado: false });
});

beforeEach(async () => {
  gateway.limpar();
  dados = await semear();
  pacientes = await semearPacientes();
});

afterAll(async () => {
  // `parar` encerra o pool compartilhado; o primeiro servidor só fecha a porta.
  await fechar(semPix);
  await parar(comPix);
});

/** Agenda, pelo app, o horário de amanhã do José, como o paciente A. */
async function agendada() {
  const r = await request(comPix).post('/consultas').set(comoA).send({ horarioId: dados.horarios.amanha, versao: 0 });
  expect(r.status).toBe(201);
  return r.body.consulta;
}

const pedirPix = (servidor, cabecalhos, id) =>
  request(servidor).post(`/consultas/${id}/pagamento/pix`).set(cabecalhos);
const conferir = (servidor, cabecalhos, id) =>
  request(servidor).post(`/consultas/${id}/pagamento/pix/conferir`).set(cabecalhos);

async function pagamentosDa(consultaId) {
  const { rows } = await consultar(
    `SELECT meio, status, pagamento_externo_id, preferencia_id, checkout_url,
            pix_copia_e_cola, pix_qr_base64, referencia_externa
       FROM pagamento WHERE consulta_id = $1 ORDER BY id`,
    [consultaId]
  );
  return rows;
}

async function statusDa(consultaId) {
  const { rows } = await consultar('SELECT status FROM consulta WHERE id = $1', [consultaId]);
  return rows[0].status;
}

describe('com o Pix desligado', () => {
  test('as rotas do Pix não existem: 404 de rota, como antes', async () => {
    const consulta = await agendada();

    for (const r of [await pedirPix(semPix, comoA, consulta.id), await conferir(semPix, comoA, consulta.id)]) {
      expect(r.status).toBe(404);
      expect(r.body.erro.codigo).toBe('ROTA_NAO_ENCONTRADA');
    }
    expect(gateway.checkouts).toHaveLength(0);
    expect(await pagamentosDa(consulta.id)).toHaveLength(0);
  });

  test('o checkout de sempre continua igual, e grava meio "checkout"', async () => {
    const consulta = await agendada();

    const r = await request(semPix).post(`/consultas/${consulta.id}/pagamento`).set(comoA);

    expect(r.status).toBe(201);
    expect(r.body.pagamento.checkoutUrl).toMatch(/^https:/);
    const [pagamento] = await pagamentosDa(consulta.id);
    expect(pagamento).toMatchObject({ meio: 'checkout', pix_copia_e_cola: null, pix_qr_base64: null });
  });
});

describe('POST /consultas/:id/pagamento/pix', () => {
  test('cria o Pix: o código, a imagem, o prazo e o valor', async () => {
    const consulta = await agendada();

    const r = await pedirPix(comPix, comoA, consulta.id);

    expect(r.status).toBe(201);
    expect(r.body.pix).toEqual({
      copiaECola: expect.stringContaining('copia-e-cola'),
      qrCodeBase64: expect.any(String),
      expiraEm: consulta.reservaExpiraEm,
      valorCentavos: 25000,
      valorFormatado: 'R$ 250,00',
    });
    const [pagamento] = await pagamentosDa(consulta.id);
    expect(pagamento).toMatchObject({
      meio: 'pix',
      status: 'pendente',
      checkout_url: null,
      preferencia_id: gateway.checkouts[0].pedidoId,
      pix_copia_e_cola: r.body.pix.copiaECola,
    });
    // O que foi ao provedor: referência, valor e prazo — nada do paciente.
    expect(Object.keys(gateway.checkouts[0]).sort()).toEqual(['expiraEm', 'meio', 'pedidoId', 'referencia', 'valor']);
  });

  test('pedir de novo devolve o MESMO Pix, sem criar outro no provedor', async () => {
    const consulta = await agendada();
    const primeiro = await pedirPix(comPix, comoA, consulta.id);

    const segundo = await pedirPix(comPix, comoA, consulta.id);

    expect(segundo.status).toBe(200);
    expect(segundo.body.pix).toEqual(primeiro.body.pix);
    expect(gateway.checkouts).toHaveLength(1);
    expect(await pagamentosDa(consulta.id)).toHaveLength(1);
  });

  test('com a página do Mercado Pago já aberta, recusa: 409 PAGAMENTO_EM_ANDAMENTO', async () => {
    const consulta = await agendada();
    await request(comPix).post(`/consultas/${consulta.id}/pagamento`).set(comoA);

    const r = await pedirPix(comPix, comoA, consulta.id);

    expect(r.status).toBe(409);
    expect(r.body.erro).toMatchObject({ codigo: 'PAGAMENTO_EM_ANDAMENTO', acao: null });
    expect(await pagamentosDa(consulta.id)).toHaveLength(1);
  });

  test('com o Pix aberto, a página do Mercado Pago é recusada do mesmo jeito', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);

    const r = await request(comPix).post(`/consultas/${consulta.id}/pagamento`).set(comoA);

    expect(r.status).toBe(409);
    expect(r.body.erro.codigo).toBe('PAGAMENTO_EM_ANDAMENTO');
    expect(await pagamentosDa(consulta.id)).toHaveLength(1);
  });

  test('consulta de outro paciente: 404, igual a inexistente', async () => {
    const consulta = await agendada();

    const r = await pedirPix(comPix, comoB, consulta.id);

    expect(r.status).toBe(404);
    expect(gateway.checkouts).toHaveLength(0);
  });

  test('consulta já paga não se paga de novo: 422 CONSULTA_NAO_PAGAVEL', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);
    gateway.pagar(gateway.checkouts[0].referencia);
    await conferir(comPix, comoA, consulta.id);

    const r = await pedirPix(comPix, comoA, consulta.id);

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CONSULTA_NAO_PAGAVEL');
  });

  test('provedor fora do ar: 503, e nada é gravado', async () => {
    const consulta = await agendada();
    gateway.indisponivel = true;

    const r = await pedirPix(comPix, comoA, consulta.id);

    expect(r.status).toBe(503);
    expect(r.body.erro.codigo).toBe('PAGAMENTO_INDISPONIVEL');
    expect(await pagamentosDa(consulta.id)).toHaveLength(0);
  });
});

describe('POST /consultas/:id/pagamento/pix/conferir', () => {
  test('antes de pagar, a consulta continua aguardando pagamento', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);

    const r = await conferir(comPix, comoA, consulta.id);

    expect(r.status).toBe(200);
    expect(r.body.consulta).toMatchObject({ id: consulta.id, status: 'pendente_pagamento' });
  });

  test('pago, confirma a consulta — e conferir de novo não muda nada', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);
    const pago = gateway.pagar(gateway.checkouts[0].referencia);

    const r = await conferir(comPix, comoA, consulta.id);
    const deNovo = await conferir(comPix, comoA, consulta.id);

    expect(r.body.consulta).toMatchObject({ status: 'confirmada', formaDePagamento: 'app' });
    expect(deNovo.body.consulta.status).toBe('confirmada');
    const pagamentos = await pagamentosDa(consulta.id);
    expect(pagamentos).toHaveLength(1);
    expect(pagamentos[0]).toMatchObject({ meio: 'pix', status: 'aprovado', pagamento_externo_id: pago.id });
  });

  test('valor diferente do da consulta não confirma', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);
    gateway.pagar(gateway.checkouts[0].referencia, { valorCentavos: 100 });

    const r = await conferir(comPix, comoA, consulta.id);

    expect(r.body.consulta.status).toBe('pendente_pagamento');
    expect(await statusDa(consulta.id)).toBe('pendente_pagamento');
  });

  test('provedor fora do ar: a consulta volta como está, sem erro', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);
    gateway.indisponivel = true;

    const r = await conferir(comPix, comoA, consulta.id);

    expect(r.status).toBe(200);
    expect(r.body.consulta.status).toBe('pendente_pagamento');
  });

  test('consulta de outro paciente: 404, e nada é consultado', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);
    gateway.pagar(gateway.checkouts[0].referencia);

    const r = await conferir(comPix, comoB, consulta.id);

    expect(r.status).toBe(404);
    expect(await statusDa(consulta.id)).toBe('pendente_pagamento');
  });

  test('o checkout da página não é conferido por esta rota', async () => {
    const consulta = await agendada();
    await request(comPix).post(`/consultas/${consulta.id}/pagamento`).set(comoA);
    gateway.pagar(gateway.checkouts[0].referencia);

    const r = await conferir(comPix, comoA, consulta.id);

    // Quem confirma o checkout é o webhook ou a reconciliação, como sempre.
    expect(r.body.consulta.status).toBe('pendente_pagamento');
  });
});

describe('a reconciliação da expiração enxerga o Pix, sem mudança', () => {
  test('Pix pago e reserva vencida: a rotina confirma em vez de cancelar', async () => {
    const consulta = await agendada();
    await pedirPix(comPix, comoA, consulta.id);
    gateway.pagar(gateway.checkouts[0].referencia);
    await consultar(
      `UPDATE consulta SET reserva_expira_em = now() - INTERVAL '1 minute' WHERE id = $1`,
      [consulta.id]
    );

    const resultado = await expirar.executar();

    expect(resultado).toMatchObject({ expiradas: 0, confirmadas: 1 });
    expect(await statusDa(consulta.id)).toBe('confirmada');
  });
});

describe('as restrições da migration 012', () => {
  async function inserir(meio, copiaECola, qr) {
    const { rows: c } = await consultar(
      `INSERT INTO consulta (paciente_id, horario_id, valor_centavos, periodo, reserva_expira_em)
       SELECT $1, h.id, 1000, tstzrange(h.inicio, h.fim), now() + INTERVAL '15 minutes'
         FROM horario h WHERE h.id = $2 RETURNING id`,
      [pacientes.a, dados.horarios.amanha]
    );
    return consultar(
      `INSERT INTO pagamento (consulta_id, referencia_externa, status, valor_centavos, meio, pix_copia_e_cola, pix_qr_base64)
       VALUES ($1, 'ref-restricao', 'pendente', 1000, $2, $3, $4)`,
      [c[0].id, meio, copiaECola, qr]
    );
  }

  test.each([
    ['checkout com "copia e cola"', 'checkout', 'codigo', null, 'pagamento_copia_e_cola_so_no_pix'],
    ['checkout com imagem', 'checkout', null, 'img', 'pagamento_qr_so_no_pix'],
    ['Pix sem "copia e cola"', 'pix', null, 'img', 'pagamento_copia_e_cola_so_no_pix'],
    ['meio desconhecido', 'boleto', null, null, 'pagamento_meio_conhecido'],
  ])('%s é recusado', async (_rotulo, meio, copiaECola, qr, restricao) => {
    await expect(inserir(meio, copiaECola, qr)).rejects.toMatchObject({ constraint: restricao });
  });
});
