'use strict';

/**
 * Versão 2, Etapa 21: a regra de aceitação da forma de pagamento, o
 * agendamento com plano ou na clínica (com dublês) e o que muda na consulta.
 */

const { garantirQueAceita } = require('../../src/domain/formasDePagamento');
const { AgendarConsulta } = require('../../src/application/AgendarConsulta');
const { Consulta } = require('../../src/domain/Consulta');
const { relogioFixo } = require('../../src/domain/Relogio');
const apresentar = require('../../src/interfaces/http/apresentadores');
const { criarRepositorios, umHorario } = require('../helpers/repositoriosFalsos');

describe('garantirQueAceita', () => {
  const tudo = { aceitaPagamentoNoApp: true, aceitaPagarNaClinica: true, aceitaOPlano: true };

  test.each(['app', 'plano', 'clinica'])('%s aceito passa', (forma) => {
    expect(() => garantirQueAceita({ forma, ...tudo })).not.toThrow();
  });

  test.each([
    ['app', { aceitaPagamentoNoApp: false }, 'FORMA_DE_PAGAMENTO_NAO_ACEITA'],
    ['clinica', { aceitaPagarNaClinica: false }, 'FORMA_DE_PAGAMENTO_NAO_ACEITA'],
    ['plano', { aceitaOPlano: false }, 'PLANO_NAO_ACEITO'],
  ])('%s recusado → %j → %s, 422 e ação nula', (forma, recusa, codigo) => {
    expect(() => garantirQueAceita({ forma, ...tudo, ...recusa })).toThrow(
      expect.objectContaining({ codigo, status: 422, acao: null })
    );
  });

  test('forma desconhecida é erro de programação', () => {
    expect(() => garantirQueAceita({ forma: 'pix', ...tudo })).toThrow(TypeError);
  });
});

describe('AgendarConsulta com plano ou na clínica', () => {
  const AGORA = new Date('2026-11-04T12:00:00-03:00');
  const DAQUI_A_UM_DIA = new Date('2026-11-05T09:00:00-03:00');
  const UNIMED = 3;

  function cenario(aceitacao) {
    const horario = umHorario({ id: 1, inicio: DAQUI_A_UM_DIA, versao: 0 });
    const repos = criarRepositorios([horario]);
    repos.horarios.definirAceitacao(horario.profissionalId, aceitacao);
    const agendar = new AgendarConsulta({
      horarios: repos.horarios,
      consultas: repos.consultas,
      relogio: relogioFixo(AGORA),
    });
    return { ...repos, agendar };
  }

  test('com plano aceito, nasce confirmada e sem prazo de reserva', async () => {
    const { agendar, horarios } = cenario({ planos: [UNIMED] });

    const consulta = await agendar.executar({
      pacienteId: 7, horarioId: 1, versao: 0, formaDePagamento: 'plano', planoId: UNIMED,
    });

    expect(consulta).toMatchObject({ status: 'confirmada', formaDePagamento: 'plano', reservaExpiraEm: null });
    expect(consulta.plano.id).toBe(UNIMED);
    expect((await horarios.porId(1)).status).toBe('reservado');
  });

  test('na clínica aceita, também confirmada e sem prazo', async () => {
    const { agendar } = cenario({ clinica: true });

    const consulta = await agendar.executar({
      pacienteId: 7, horarioId: 1, versao: 0, formaDePagamento: 'clinica',
    });

    expect(consulta).toMatchObject({ status: 'confirmada', formaDePagamento: 'clinica', reservaExpiraEm: null, plano: null });
  });

  test('sem forma, o fluxo de sempre: pendente, com prazo de 15 minutos', async () => {
    const { agendar } = cenario({});

    const consulta = await agendar.executar({ pacienteId: 7, horarioId: 1, versao: 0 });

    expect(consulta).toMatchObject({ status: 'pendente_pagamento', formaDePagamento: 'app' });
    expect(consulta.reservaExpiraEm.getTime() - AGORA.getTime()).toBe(15 * 60_000);
  });

  test.each([
    [{ formaDePagamento: 'plano', planoId: 99 }, { planos: [UNIMED] }, 'PLANO_NAO_ACEITO'],
    [{ formaDePagamento: 'clinica' }, {}, 'FORMA_DE_PAGAMENTO_NAO_ACEITA'],
    [{}, { app: false, clinica: true }, 'FORMA_DE_PAGAMENTO_NAO_ACEITA'],
  ])('%j recusado deixa o horário como estava', async (pedido, aceitacao, codigo) => {
    const { agendar, horarios } = cenario(aceitacao);

    await expect(
      agendar.executar({ pacienteId: 7, horarioId: 1, versao: 0, ...pedido })
    ).rejects.toMatchObject({ codigo });

    expect(await horarios.porId(1)).toMatchObject({ status: 'disponivel', versao: 0 });
  });

  test.each([
    [{ formaDePagamento: 'plano' }],
    [{ formaDePagamento: 'clinica', planoId: UNIMED }],
    [{ planoId: UNIMED }],
    [{ formaDePagamento: 'pix' }],
  ])('combinação inválida %j é recusada antes de tocar no horário', async (pedido) => {
    const { agendar, horarios } = cenario({ clinica: true, planos: [UNIMED] });

    await expect(
      agendar.executar({ pacienteId: 7, horarioId: 1, versao: 0, ...pedido })
    ).rejects.toMatchObject({ codigo: 'DADOS_INCOMPLETOS' });
    expect((await horarios.porId(1)).versao).toBe(0);
  });
});

describe('a consulta da versão 2', () => {
  const base = { id: 1, pacienteId: 7, horarioId: 1, valor: 15000 };

  test('consulta de plano não se paga pelo aplicativo, com mensagem própria', () => {
    const consulta = new Consulta({
      ...base, status: 'confirmada', formaDePagamento: 'plano', plano: { id: 3, nome: 'Alfa' },
    });

    expect(() => consulta.garantirQuePodeSerPagaPor(7, new Date())).toThrow(
      expect.objectContaining({ codigo: 'CONSULTA_NAO_PAGAVEL', message: 'Esta consulta não é paga pelo aplicativo.' })
    );
  });

  test('a do app já paga continua dizendo que já está paga', () => {
    const consulta = new Consulta({ ...base, status: 'confirmada' });

    expect(() => consulta.garantirQuePodeSerPagaPor(7, new Date())).toThrow(/já está paga/);
  });

  test('o apresentador traz a forma e o plano, sempre', () => {
    expect(apresentar.consulta(new Consulta({ ...base }))).toMatchObject({ formaDePagamento: 'app', plano: null });
    expect(
      apresentar.consulta(
        new Consulta({ ...base, status: 'confirmada', formaDePagamento: 'plano', plano: { id: 3, nome: 'Alfa', x: 1 } })
      )
    ).toEqual(expect.objectContaining({ formaDePagamento: 'plano', plano: { id: 3, nome: 'Alfa' } }));
  });
});
