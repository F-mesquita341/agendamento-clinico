'use strict';

/**
 * As decisões sobre um pagamento, sem banco, sem rede e sem Mercado Pago.
 *
 * O adaptador lê a consulta sob bloqueio e pergunta ao domínio o que fazer com
 * o pagamento que o gateway reportou. Tudo o que importa para o dinheiro do
 * paciente está nesta função: confirmar ou não, e que anomalia registrar.
 */

const { Consulta, STATUS_CONSULTA } = require('../../src/domain/Consulta');
const {
  decidirEfeitoDoPagamento,
  STATUS_PAGAMENTO,
  DESCRICAO_DO_ITEM,
} = require('../../src/domain/Pagamento');

const AGORA = new Date('2026-10-01T10:00:00-03:00');
const PRECO = 25000;

function consultaEm(status, { pacienteId = 7, expiraEm = new Date(AGORA.getTime() + 10 * 60_000) } = {}) {
  return new Consulta({
    id: 1,
    pacienteId,
    horarioId: 3,
    status,
    valor: PRECO,
    reservaExpiraEm: expiraEm,
    motivoCancelamento: status === STATUS_CONSULTA.CANCELADA ? 'reserva_expirada' : null,
  });
}

function aprovado(extra = {}) {
  return { status: STATUS_PAGAMENTO.APROVADO, valorCentavos: PRECO, moeda: 'BRL', modoReal: false, ...extra };
}

describe('descrição do item enviada ao provedor', () => {
  test('é genérica: nem especialidade, nem profissional', () => {
    // LGPD, Art. 11 §4º: o provedor de pagamento não precisa saber que tipo de
    // consulta foi comprada, e o extrato do cartão não deve revelar.
    expect(DESCRICAO_DO_ITEM).toBe('Consulta médica');
  });
});

describe('decidirEfeitoDoPagamento', () => {
  test('aprovado numa consulta aguardando pagamento: confirma', () => {
    expect(
      decidirEfeitoDoPagamento({
        consulta: consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO),
        pagamento: aprovado(),
        statusAnterior: null,
      })
    ).toEqual({
      acao: 'registrar',
      statusDoPagamento: STATUS_PAGAMENTO.APROVADO,
      confirmarConsulta: true,
      anomalia: null,
    });
  });

  test('a mesma notificação de novo não muda nada', () => {
    const efeito = decidirEfeitoDoPagamento({
      consulta: consultaEm(STATUS_CONSULTA.CONFIRMADA),
      pagamento: aprovado(),
      statusAnterior: STATUS_PAGAMENTO.APROVADO,
    });

    expect(efeito.acao).toBe('ignorar');
    expect(efeito.confirmarConsulta).toBe(false);
    expect(efeito.anomalia).toBeNull();
  });

  test('pagamento em modo real é ignorado e registrado como anomalia — só sandbox', () => {
    const efeito = decidirEfeitoDoPagamento({
      consulta: consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO),
      pagamento: aprovado({ modoReal: true }),
      statusAnterior: null,
    });

    expect(efeito).toMatchObject({
      acao: 'ignorar',
      confirmarConsulta: false,
      anomalia: 'pagamento_em_modo_real',
    });
  });

  test.each([
    ['valor menor', { valorCentavos: PRECO - 1 }],
    ['valor maior', { valorCentavos: PRECO + 100 }],
    ['outra moeda', { moeda: 'USD' }],
  ])('%s não confirma, e fica registrado como anomalia', (_rotulo, divergencia) => {
    const efeito = decidirEfeitoDoPagamento({
      consulta: consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO),
      pagamento: aprovado(divergencia),
      statusAnterior: null,
    });

    expect(efeito).toMatchObject({
      acao: 'registrar',
      confirmarConsulta: false,
      anomalia: 'valor_divergente',
    });
  });

  test('aprovado depois do cancelamento: registra para estorno, não ressuscita a consulta', () => {
    // O horário pode já ser de outra pessoa. Devolver a consulta seria
    // reintroduzir justamente o agendamento duplicado que o trabalho evita.
    const efeito = decidirEfeitoDoPagamento({
      consulta: consultaEm(STATUS_CONSULTA.CANCELADA),
      pagamento: aprovado(),
      statusAnterior: null,
    });

    expect(efeito).toMatchObject({
      acao: 'registrar',
      statusDoPagamento: STATUS_PAGAMENTO.APROVADO,
      confirmarConsulta: false,
      anomalia: 'pagamento_apos_cancelamento',
    });
  });

  test('segundo pagamento aprovado para consulta já paga é anomalia', () => {
    const efeito = decidirEfeitoDoPagamento({
      consulta: consultaEm(STATUS_CONSULTA.CONFIRMADA),
      pagamento: aprovado(),
      statusAnterior: null,
    });

    expect(efeito).toMatchObject({ confirmarConsulta: false, anomalia: 'pagamento_duplicado' });
  });

  test.each([STATUS_PAGAMENTO.RECUSADO, STATUS_PAGAMENTO.PENDENTE, STATUS_PAGAMENTO.ESTORNADO])(
    'pagamento %s é registrado e não confirma',
    (status) => {
      const efeito = decidirEfeitoDoPagamento({
        consulta: consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO),
        pagamento: aprovado({ status }),
        statusAnterior: null,
      });

      expect(efeito).toEqual({
        acao: 'registrar',
        statusDoPagamento: status,
        confirmarConsulta: false,
        anomalia: null,
      });
    }
  );

  test('recusado e depois aprovado no mesmo checkout: a aprovação confirma', () => {
    // O Mercado Pago deixa tentar de novo no mesmo checkout, com outro cartão.
    const efeito = decidirEfeitoDoPagamento({
      consulta: consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO),
      pagamento: aprovado(),
      statusAnterior: STATUS_PAGAMENTO.RECUSADO,
    });

    expect(efeito.confirmarConsulta).toBe(true);
  });
});

describe('Consulta.garantirQuePodeSerPagaPor', () => {
  test('o dono paga uma reserva dentro do prazo', () => {
    expect(() =>
      consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO).garantirQuePodeSerPagaPor(7, AGORA)
    ).not.toThrow();
  });

  test('outro paciente não paga — o domínio diz AcessoNegado, e a rota traduz em 404', () => {
    expect(() =>
      consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO).garantirQuePodeSerPagaPor(8, AGORA)
    ).toThrow(expect.objectContaining({ codigo: 'ACESSO_NEGADO' }));
  });

  test.each([
    [STATUS_CONSULTA.CONFIRMADA, /já está paga/],
    [STATUS_CONSULTA.CANCELADA, /não pode mais ser paga/],
  ])('consulta %s não é pagável', (status, mensagem) => {
    expect(() => consultaEm(status).garantirQuePodeSerPagaPor(7, AGORA)).toThrow(
      expect.objectContaining({ codigo: 'CONSULTA_NAO_PAGAVEL', message: expect.stringMatching(mensagem) })
    );
  });

  test('reserva vencida não é pagável, mesmo antes de a rotina expirá-la', () => {
    const vencida = consultaEm(STATUS_CONSULTA.PENDENTE_PAGAMENTO, {
      expiraEm: new Date(AGORA.getTime() - 1),
    });

    expect(() => vencida.garantirQuePodeSerPagaPor(7, AGORA)).toThrow(
      expect.objectContaining({ codigo: 'RESERVA_EXPIRADA' })
    );
  });
});
