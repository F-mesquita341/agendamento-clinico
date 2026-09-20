'use strict';

/**
 * Pagamento, webhook e expiração de reservas, contra o PostgreSQL real.
 *
 * O Mercado Pago é um dublê (tests/helpers/gatewayFalso.js); as notificações são
 * assinadas com uma chave de teste, pela mesma fórmula da verificação. Que essa
 * fórmula é a do Mercado Pago, quem prova é uma notificação real, na parte B da
 * Etapa 8 — aqui se prova tudo o que acontece depois da assinatura.
 */

const crypto = require('node:crypto');
const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { semear, semearPacientes } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { GatewayFalso } = require('../helpers/gatewayFalso');
const { consultar, pool } = require('../../src/infra/db/pool');
const { RepositorioDeConsultasPg } = require('../../src/infra/db/RepositorioDeConsultasPg');
const { RepositorioDePagamentosPg } = require('../../src/infra/db/RepositorioDePagamentosPg');
const { ExpirarReservasVencidas } = require('../../src/application/ExpirarReservasVencidas');

const SEGREDO = 'segredo-de-teste-do-webhook';
const comoA = { Authorization: `Bearer ${tokenDe('uid-paciente-a', 'paciente.a@example.com')}` };
const comoB = { Authorization: `Bearer ${tokenDe('uid-paciente-b', 'paciente.b@example.com')}` };

const gateway = new GatewayFalso();
const expirar = new ExpirarReservasVencidas({
  consultas: new RepositorioDeConsultasPg(),
  pagamentos: new RepositorioDePagamentosPg(),
  gateway,
});

let servidor;
let dados;

beforeAll(async () => {
  servidor = await iniciar({ gateway, segredoDoWebhook: SEGREDO });
});

beforeEach(async () => {
  gateway.limpar();
  dados = await semear();
  await semearPacientes();
});

afterAll(() => parar(servidor));

// --- Utilitários ------------------------------------------------------------

/** Agenda o horário de amanhã do José como paciente A e devolve a consulta. */
async function agendada() {
  const r = await request(servidor)
    .post('/consultas')
    .set(comoA)
    .send({ horarioId: dados.horarios.amanha, versao: 0 });
  expect(r.status).toBe(201);
  return r.body.consulta;
}

function pedirPagamento(cabecalhos, consultaId) {
  return request(servidor).post(`/consultas/${consultaId}/pagamento`).set(cabecalhos);
}

/** A referência que a API mandou ao provedor no último checkout. */
const referenciaDoUltimoCheckout = () => gateway.checkouts.at(-1).referencia;

/**
 * Envia uma notificação como o Mercado Pago enviaria, assinada com a chave.
 * `estragar` recebe as partes e devolve outras — para forjar.
 */
function notificar(pagamentoId, { segredo = SEGREDO, tipo = 'payment', estragar = (p) => p } = {}) {
  const partes = estragar({
    idNaQuery: String(pagamentoId),
    idAssinado: String(pagamentoId),
    requisicao: crypto.randomUUID(),
    ts: String(Math.floor(Date.now() / 1000)),
    segredo,
  });
  const v1 = crypto
    .createHmac('sha256', partes.segredo)
    .update(`id:${partes.idAssinado.toLowerCase()};request-id:${partes.requisicao};ts:${partes.ts};`)
    .digest('hex');

  const query = partes.semTipoNaQuery
    ? `data.id=${encodeURIComponent(partes.idNaQuery)}`
    : `data.id=${encodeURIComponent(partes.idNaQuery)}&type=${tipo}`;
  const pedido = request(servidor)
    .post(`/webhooks/mercadopago?${query}`)
    .set('x-request-id', partes.requisicao);
  if (partes.semAssinatura !== true) pedido.set('x-signature', `ts=${partes.ts},v1=${v1}`);
  return pedido.send({ action: 'payment.updated', type: tipo, data: { id: String(pagamentoId) } });
}

async function estado(consultaId) {
  const { rows } = await consultar(
    `SELECT c.status, c.motivo_cancelamento, h.status AS horario_status, h.versao
       FROM consulta c JOIN horario h ON h.id = c.horario_id
      WHERE c.id = $1`,
    [consultaId]
  );
  return rows[0];
}

async function pagamentosDa(consultaId) {
  const { rows } = await consultar(
    `SELECT status, pagamento_externo_id, valor_centavos, preferencia_id
       FROM pagamento WHERE consulta_id = $1 ORDER BY id`,
    [consultaId]
  );
  return rows;
}

async function auditoria(acao) {
  const { rows } = await consultar(
    'SELECT ator_tipo, entidade_id, detalhe FROM auditoria WHERE acao = $1 ORDER BY id',
    [acao]
  );
  return rows;
}

/**
 * Espera até alguém estar bloqueado PELA transação do teste.
 *
 * `pg_blocking_pids` diz quem está travando quem: sem isso, bastaria outra
 * sessão qualquer do banco esperar um bloqueio — outra execução da suíte, uma
 * conexão deixada para trás — para o teste seguir adiante cedo demais e deixar
 * de provar justamente a trava que ele existe para provar.
 */
async function esperarBloqueioPor(pidDoTeste, prazoMs = 15_000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) {
    const { rows } = await consultar(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
      [pidDoTeste]
    );
    if (rows[0].n > 0) return;
    await new Promise((resolver) => setTimeout(resolver, 50));
  }
  throw new Error('Ninguém ficou esperando o bloqueio da transação do teste.');
}

/** O identificador da sessão de um cliente, para saber quem ela está travando. */
async function pidDe(cliente) {
  const { rows } = await cliente.query('SELECT pg_backend_pid() AS pid');
  return rows[0].pid;
}

async function vencer(consultaId, minutosAtras = 1) {
  await consultar(
    `UPDATE consulta SET reserva_expira_em = now() - make_interval(mins => $2) WHERE id = $1`,
    [consultaId, minutosAtras]
  );
}

// --- POST /consultas/:id/pagamento ------------------------------------------

describe('POST /consultas/:id/pagamento', () => {
  test('abre o checkout com o valor da consulta e o prazo da reserva', async () => {
    const consulta = await agendada();

    const r = await pedirPagamento(comoA, consulta.id);

    expect(r.status).toBe(201);
    expect(r.body.pagamento).toMatchObject({
      status: 'pendente',
      checkoutUrl: 'https://sandbox.exemplo/checkout/pref-1',
      expiraEm: consulta.reservaExpiraEm,
      valorCentavos: 25000,
      valorFormatado: 'R$ 250,00',
    });

    const enviado = gateway.checkouts[0];
    expect(enviado.descricao).toBe('Consulta médica');
    expect(enviado.valor.centavos).toBe(25000);
    expect(enviado.expiraEm.toISOString()).toBe(consulta.reservaExpiraEm);
    // A referência é um UUID aleatório, e não o id interno da consulta. (Uma
    // versão anterior verificava que ela "não continha" o id — com o id valendo
    // 1, quase todo UUID contém o dígito, e o teste falhava por acaso.)
    expect(enviado.referencia).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(enviado.referencia).not.toBe(String(consulta.id));

    expect(await pagamentosDa(consulta.id)).toEqual([
      { status: 'pendente', pagamento_externo_id: null, valor_centavos: 25000, preferencia_id: 'pref-1' },
    ]);
    expect(await auditoria('pagamento.checkout_criado')).toHaveLength(1);
  });

  test('pedir de novo devolve o mesmo checkout, sem criar outro', async () => {
    const consulta = await agendada();
    const primeiro = await pedirPagamento(comoA, consulta.id);

    const segundo = await pedirPagamento(comoA, consulta.id);

    expect(segundo.status).toBe(200);
    expect(segundo.body.pagamento.checkoutUrl).toBe(primeiro.body.pagamento.checkoutUrl);
    expect(gateway.checkouts).toHaveLength(1);
  });

  test('dois pedidos simultâneos terminam com um só checkout aberto', async () => {
    const consulta = await agendada();

    const respostas = await Promise.all([pedirPagamento(comoA, consulta.id), pedirPagamento(comoA, consulta.id)]);

    expect(respostas.map((r) => r.status).every((s) => s === 200 || s === 201)).toBe(true);
    expect(respostas[0].body.pagamento.checkoutUrl).toBe(respostas[1].body.pagamento.checkoutUrl);
    expect(await pagamentosDa(consulta.id)).toHaveLength(1);
  });

  test('consulta de outro paciente é 404, e nenhum checkout é criado', async () => {
    const consulta = await agendada();

    const r = await pedirPagamento(comoB, consulta.id);

    expect(r.status).toBe(404);
    expect(gateway.checkouts).toHaveLength(0);
  });

  test('consulta cancelada não é pagável', async () => {
    const consulta = await agendada();
    await request(servidor).patch(`/consultas/${consulta.id}/cancelamento`).set(comoA);

    const r = await pedirPagamento(comoA, consulta.id);

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CONSULTA_NAO_PAGAVEL');
  });

  test('reserva vencida não é pagável, mesmo antes de a rotina expirá-la', async () => {
    const consulta = await agendada();
    await vencer(consulta.id);

    const r = await pedirPagamento(comoA, consulta.id);

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('RESERVA_EXPIRADA');
    expect(gateway.checkouts).toHaveLength(0);
  });

  test('provedor fora do ar é 503 com a ação de tentar de novo', async () => {
    const consulta = await agendada();
    gateway.indisponivel = true;

    const r = await pedirPagamento(comoA, consulta.id);

    expect(r.status).toBe(503);
    expect(r.body.erro).toMatchObject({ codigo: 'PAGAMENTO_INDISPONIVEL', acao: 'tentar_novamente' });
    expect(await pagamentosDa(consulta.id)).toEqual([]);
  });
});

// --- POST /webhooks/mercadopago ---------------------------------------------

describe('POST /webhooks/mercadopago', () => {
  async function comCheckout() {
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    return { consulta, referencia: referenciaDoUltimoCheckout() };
  }

  test('pagamento aprovado confirma a consulta', async () => {
    const { consulta, referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia);

    const r = await notificar(pagamento.id);

    expect(r.status).toBe(200);
    expect(await estado(consulta.id)).toMatchObject({ status: 'confirmada', horario_status: 'reservado' });
    expect(await pagamentosDa(consulta.id)).toEqual([
      expect.objectContaining({ status: 'aprovado', pagamento_externo_id: pagamento.id }),
    ]);
    const confirmacoes = await auditoria('consulta.confirmada');
    expect(confirmacoes).toHaveLength(1);
    expect(confirmacoes[0].ator_tipo).toBe('webhook');
  });

  test('a mesma notificação de novo não muda nada nem gera auditoria nova', async () => {
    const { referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia);
    await notificar(pagamento.id);
    const { rows: antes } = await consultar('SELECT count(*)::int AS n FROM auditoria');

    const r = await notificar(pagamento.id);

    expect(r.status).toBe(200);
    const { rows: depois } = await consultar('SELECT count(*)::int AS n FROM auditoria');
    expect(depois[0].n).toBe(antes[0].n);
  });

  test.each([
    ['sem assinatura', (p) => ({ ...p, semAssinatura: true })],
    ['assinada com outra chave', (p) => ({ ...p, segredo: 'chave-de-quem-forjou' })],
    ['com o id trocado depois de assinada', (p) => ({ ...p, idNaQuery: '999' })],
  ])('notificação forjada — %s — é 401 e nada muda', async (_rotulo, estragar) => {
    const { consulta, referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia);

    const r = await notificar(pagamento.id, { estragar });

    expect(r.status).toBe(401);
    expect(r.body.erro.codigo).toBe('ASSINATURA_INVALIDA');
    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });
    expect(await pagamentosDa(consulta.id)).toEqual([
      expect.objectContaining({ status: 'pendente', pagamento_externo_id: null }),
    ]);
  });

  test('valor divergente não confirma, e fica registrado como anomalia', async () => {
    const { consulta, referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia, { valorCentavos: 100 });

    await notificar(pagamento.id);

    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });
    const anomalias = await auditoria('pagamento.anomalia');
    expect(anomalias.map((a) => a.detalhe.anomalia)).toEqual(['valor_divergente']);
  });

  test('o modo relatado pelo provedor não bloqueia, mas fica registrado', async () => {
    // Todo pagamento do trabalho chega assim: a conta de teste do Mercado Pago
    // opera em modo produção, e `live_mode` vem verdadeiro mesmo com dinheiro
    // fictício. Se isto bloqueasse, nenhuma consulta seria confirmada.
    // A garantia de sandbox é a verificação da conta na subida da API.
    const { consulta, referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia, { modoReal: true });

    await notificar(pagamento.id);

    expect(await estado(consulta.id)).toMatchObject({ status: 'confirmada' });
    expect(await auditoria('pagamento.anomalia')).toEqual([]);
    expect((await auditoria('pagamento.aprovado'))[0].detalhe.modoReal).toBe(true);
  });

  test('pagamento que o provedor não conhece não muda nada', async () => {
    const { consulta } = await comCheckout();

    const r = await notificar('123456789');

    expect(r.status).toBe(200);
    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });
  });

  test('evento de outro tipo, assinado, é aceito e ignorado', async () => {
    const { consulta, referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia);

    const r = await notificar(pagamento.id, { tipo: 'merchant_order' });

    expect(r.status).toBe(200);
    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });
  });

  test('recusado e depois aprovado no mesmo checkout: a aprovação confirma', async () => {
    const { consulta, referencia } = await comCheckout();
    await notificar(gateway.pagar(referencia, { status: 'recusado' }).id);
    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });

    await notificar(gateway.pagar(referencia).id);

    expect(await estado(consulta.id)).toMatchObject({ status: 'confirmada' });
    expect((await pagamentosDa(consulta.id)).map((p) => p.status)).toEqual(['recusado', 'aprovado']);
  });

  test('tipo de evento só vale vindo da query, que é a parte assinada', async () => {
    // O corpo não entra no manifesto da assinatura. Uma notificação assinada de
    // outro evento, reenviada com o corpo trocado para "payment", não pode ser
    // tratada como pagamento.
    const { consulta, referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia);

    const r = await notificar(pagamento.id, { estragar: (p) => ({ ...p, semTipoNaQuery: true }) });

    expect(r.status).toBe(200);
    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });
  });

  test('reenvio da mesma notificação anômala não duplica a auditoria', async () => {
    // O Mercado Pago reenvia até receber 200. A proteção contra repetir a
    // anomalia é o próprio domínio: o segundo reenvio encontra o pagamento já
    // gravado com o mesmo status e sai antes de decidir qualquer coisa.
    const { referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia, { valorCentavos: 100 });

    await notificar(pagamento.id);
    await notificar(pagamento.id);

    expect(await auditoria('pagamento.anomalia')).toHaveLength(1);
  });

  test('segundo pagamento aprovado para a mesma consulta vira linha própria e anomalia', async () => {
    const { consulta, referencia } = await comCheckout();
    await notificar(gateway.pagar(referencia).id);
    const segundo = gateway.pagar(referencia);

    await notificar(segundo.id);

    expect(await estado(consulta.id)).toMatchObject({ status: 'confirmada' });
    const pagamentos = await pagamentosDa(consulta.id);
    expect(pagamentos.map((p) => p.status)).toEqual(['aprovado', 'aprovado']);
    expect(pagamentos[1].pagamento_externo_id).toBe(segundo.id);
    expect((await auditoria('pagamento.anomalia'))[0].detalhe.anomalia).toBe('pagamento_duplicado');
  });

  test('estorno depois da confirmação fica registrado como anomalia', async () => {
    const { consulta, referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia);
    await notificar(pagamento.id);

    // O mesmo pagamento, agora estornado no provedor.
    gateway.pagamentos.get(pagamento.id).status = 'estornado';
    await notificar(pagamento.id);

    // A consulta não muda sozinha — o horário já foi combinado —, mas o caso
    // não fica invisível.
    expect(await estado(consulta.id)).toMatchObject({ status: 'confirmada' });
    expect((await pagamentosDa(consulta.id))[0].status).toBe('estornado');
    expect((await auditoria('pagamento.anomalia'))[0].detalhe.anomalia).toBe('pagamento_revertido');
  });

  test('provedor fora do ar na consulta do pagamento é 503 — o Mercado Pago reenviará', async () => {
    const { referencia } = await comCheckout();
    const pagamento = gateway.pagar(referencia);
    gateway.indisponivel = true;

    const r = await notificar(pagamento.id);

    expect(r.status).toBe(503);
  });
});

// --- Expiração de reservas --------------------------------------------------

describe('expiração de reservas', () => {
  test('reserva vencida expira: horário de volta à grade, motivo e auditoria', async () => {
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    await vencer(consulta.id);

    const resultado = await expirar.executar();

    expect(resultado).toMatchObject({ expiradas: 1, confirmadas: 0 });
    expect(await estado(consulta.id)).toMatchObject({
      status: 'cancelada',
      motivo_cancelamento: 'reserva_expirada',
      horario_status: 'disponivel',
      versao: 2,
    });
    // O checkout aberto é encerrado: não dá mais para pagar pela página do provedor.
    expect((await pagamentosDa(consulta.id))[0].status).toBe('expirado');
    const expiracoes = await auditoria('consulta.expirada');
    expect(expiracoes).toHaveLength(1);
    expect(expiracoes[0].ator_tipo).toBe('sistema');

    const lida = await request(servidor).get(`/consultas/${consulta.id}`).set(comoA);
    expect(lida.body.consulta.motivoCancelamento).toBe('reserva_expirada');
  });

  test('reserva dentro do prazo não é tocada', async () => {
    const consulta = await agendada();

    expect((await expirar.executar()).expiradas).toBe(0);
    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });
  });

  test('reconciliação: pagamento sem aviso confirma em vez de expirar', async () => {
    // O aviso se perdeu — a API hibernava. A rotina pergunta ao provedor antes
    // de cancelar a consulta de quem pagou.
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    gateway.pagar(referenciaDoUltimoCheckout());
    await vencer(consulta.id);

    const resultado = await expirar.executar();

    expect(resultado).toMatchObject({ expiradas: 0, confirmadas: 1 });
    expect(await estado(consulta.id)).toMatchObject({ status: 'confirmada', horario_status: 'reservado' });
    expect((await auditoria('consulta.confirmada'))[0].ator_tipo).toBe('sistema');
  });

  test('provedor fora do ar adia a expiração — mas não para sempre', async () => {
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    gateway.indisponivel = true;

    await vencer(consulta.id, 5);
    expect(await expirar.executar()).toMatchObject({ expiradas: 0, adiadas: 1 });
    expect(await estado(consulta.id)).toMatchObject({ status: 'pendente_pagamento' });

    // Vencida há mais que o adiamento máximo: expira mesmo sem reconciliar.
    await vencer(consulta.id, 40);
    expect(await expirar.executar()).toMatchObject({ expiradas: 1 });
    expect(await estado(consulta.id)).toMatchObject({ status: 'cancelada' });
  });

  test('pagamento aprovado depois da expiração não ressuscita a consulta', async () => {
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    const referencia = referenciaDoUltimoCheckout();
    await vencer(consulta.id);
    await expirar.executar();

    await notificar(gateway.pagar(referencia).id);

    expect(await estado(consulta.id)).toMatchObject({ status: 'cancelada', horario_status: 'disponivel' });
    expect((await pagamentosDa(consulta.id)).map((p) => p.status)).toEqual(['expirado', 'aprovado']);
    expect((await auditoria('pagamento.anomalia'))[0].detalhe.anomalia).toBe('pagamento_apos_cancelamento');
  });

  test('cancelar uma consulta JÁ PAGA deixa registrado que há estorno a fazer', async () => {
    // Estorno automático está fora do escopo do trabalho. O que não pode é o
    // dinheiro ficar sem rastro: a consulta some da agenda e nada diria que
    // houve pagamento recebido por ela.
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    const pagamento = gateway.pagar(referenciaDoUltimoCheckout());
    await notificar(pagamento.id);

    await request(servidor).patch(`/consultas/${consulta.id}/cancelamento`).set(comoA);

    expect(await estado(consulta.id)).toMatchObject({ status: 'cancelada', motivo_cancelamento: 'paciente' });
    const estornos = await auditoria('pagamento.estorno_pendente');
    expect(estornos).toHaveLength(1);
    expect(estornos[0].detalhe).toMatchObject({ consultaId: consulta.id, pagamentoExterno: pagamento.id });
    // O pagamento continua aprovado: quem estorna é uma pessoa, no painel.
    expect((await pagamentosDa(consulta.id))[0].status).toBe('aprovado');
  });

  test('cancelamento pelo paciente grava o motivo e encerra o checkout', async () => {
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);

    await request(servidor).patch(`/consultas/${consulta.id}/cancelamento`).set(comoA);

    expect(await estado(consulta.id)).toMatchObject({ status: 'cancelada', motivo_cancelamento: 'paciente' });
    expect((await pagamentosDa(consulta.id))[0].status).toBe('expirado');
  });

  test('a trava da consulta: aprovação que chega durante uma expiração em curso vira anomalia', async () => {
    // Disparar webhook e expiração juntos e torcer não prova a trava: a ordem
    // perigosa depende do acaso, e o teste abaixo deste passou seis vezes
    // seguidas com o FOR UPDATE removido. Aqui a ordem é forçada: a expiração
    // é aberta e parada no meio, o webhook chega, e só quando o banco mostra
    // alguém esperando o bloqueio a expiração é confirmada.
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    const pagamento = gateway.pagar(referenciaDoUltimoCheckout());

    const expiracao = await pool.connect();
    let aplicacao;
    try {
      await expiracao.query('BEGIN');
      const pidDaExpiracao = await pidDe(expiracao);
      await expiracao.query('SELECT id FROM consulta WHERE id = $1 FOR UPDATE', [consulta.id]);
      await expiracao.query(
        "UPDATE consulta SET status = 'cancelada', motivo_cancelamento = 'reserva_expirada' WHERE id = $1",
        [consulta.id]
      );
      await expiracao.query(
        "UPDATE horario SET status = 'disponivel', versao = versao + 1 WHERE id = $1",
        [dados.horarios.amanha]
      );
      await expiracao.query(
        "UPDATE pagamento SET status = 'expirado' WHERE consulta_id = $1 AND pagamento_externo_id IS NULL",
        [consulta.id]
      );

      // O aviso de pagamento chega agora, com a expiração ainda sem COMMIT.
      aplicacao = new RepositorioDePagamentosPg().aplicarPagamento(pagamento, { ator: 'webhook' });
      await esperarBloqueioPor(pidDaExpiracao);
      await expiracao.query('COMMIT');
    } catch (erro) {
      await expiracao.query('ROLLBACK').catch(() => {});
      throw erro;
    } finally {
      expiracao.release();
    }
    await aplicacao;

    // Com a trava, o webhook esperou e leu a consulta já cancelada. Sem ela,
    // teria lido "aguardando pagamento" antes do COMMIT e confirmado por cima
    // do cancelamento — consulta confirmada com o horário de volta à grade.
    expect(await estado(consulta.id)).toMatchObject({ status: 'cancelada', horario_status: 'disponivel' });
    expect((await auditoria('pagamento.anomalia'))[0].detalhe.anomalia).toBe('pagamento_apos_cancelamento');
  });

  test('a expiração relê sob bloqueio: não cancela uma consulta paga no meio do caminho', async () => {
    // O lado oposto da corrida: a confirmação está em curso, sem COMMIT, quando
    // a rotina chega. Ela precisa esperar e desistir — expirar uma consulta paga
    // devolveria à grade o horário de quem pagou.
    const consulta = await agendada();
    await vencer(consulta.id);

    const confirmacao = await pool.connect();
    let expiracao;
    try {
      await confirmacao.query('BEGIN');
      const pidDaConfirmacao = await pidDe(confirmacao);
      await confirmacao.query('SELECT id FROM consulta WHERE id = $1 FOR UPDATE', [consulta.id]);
      await confirmacao.query("UPDATE consulta SET status = 'confirmada' WHERE id = $1", [consulta.id]);

      expiracao = new RepositorioDeConsultasPg().expirarSeVencida(consulta.id, new Date());
      await esperarBloqueioPor(pidDaConfirmacao);
      await confirmacao.query('COMMIT');
    } catch (erro) {
      await confirmacao.query('ROLLBACK').catch(() => {});
      throw erro;
    } finally {
      confirmacao.release();
    }

    expect(await expiracao).toBe(false);
    expect(await estado(consulta.id)).toMatchObject({ status: 'confirmada', horario_status: 'reservado' });
  });

  test('webhook e expiração ao mesmo tempo terminam em estado coerente', async () => {
    const consulta = await agendada();
    await pedirPagamento(comoA, consulta.id);
    const pagamento = gateway.pagar(referenciaDoUltimoCheckout());
    // A rotina não enxerga o pagamento: disputa com o webhook de verdade.
    gateway.ocultarNaBusca = true;
    await vencer(consulta.id);

    await Promise.all([notificar(pagamento.id), expirar.executar()]);

    // Os dois travam a mesma linha da consulta; quem chega depois respeita o
    // que o primeiro fez. Nunca confirmada com o horário devolvido à grade.
    const final = await estado(consulta.id);
    if (final.status === 'confirmada') {
      expect(final.horario_status).toBe('reservado');
    } else {
      expect(final).toMatchObject({ status: 'cancelada', horario_status: 'disponivel' });
      expect((await auditoria('pagamento.anomalia'))[0].detalhe.anomalia).toBe('pagamento_apos_cancelamento');
    }
  });
});
