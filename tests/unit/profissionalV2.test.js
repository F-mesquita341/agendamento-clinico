'use strict';

/**
 * Versão 2: as formas de pagamento do profissional e como o apresentador
 * distingue "não lido" de "nenhum".
 */

const { Profissional } = require('../../src/domain/Profissional');
const apresentar = require('../../src/interfaces/http/apresentadores');

const base = {
  id: 1,
  clinicaId: 7,
  clinica: { id: 7, nome: 'Clínica Exemplo' },
  nome: 'José Antônio Ferreira',
  registroConselho: 'CRM-CE 12345',
  especialidade: { id: 2, nome: 'Cardiologia' },
  valorConsulta: 25000,
};
const umPlano = [{ id: 3, nome: 'Alfa Saúde' }];

describe('formasDePagamento', () => {
  test.each([
    [{ planos: [] }, ['app']],
    [{ planos: umPlano }, ['app', 'plano']],
    [{ planos: umPlano, aceitaPagarNaClinica: true }, ['app', 'plano', 'clinica']],
    [{ planos: [], aceitaPagamentoNoApp: false, aceitaPagarNaClinica: true }, ['clinica']],
    [{ planos: umPlano, aceitaPagamentoNoApp: false, aceitaPagarNaClinica: true }, ['plano', 'clinica']],
  ])('%j → %j, sempre na ordem app, plano, clínica', (extra, formas) => {
    expect(new Profissional({ ...base, ...extra }).formasDePagamento()).toEqual(formas);
  });

  test('sem a lista de planos lida, não afirma que aceita plano', () => {
    expect(new Profissional({ ...base }).formasDePagamento()).toEqual(['app']);
  });
});

describe('apresentador do profissional, versão 2', () => {
  test('no catálogo: planos, formas e próximo horário presentes; o próximo pode ser null', () => {
    const json = apresentar.profissional(
      new Profissional({ ...base, planos: umPlano, proximoHorario: null })
    );

    expect(json.planos).toEqual(umPlano);
    expect(json.formasDePagamento).toEqual(['app', 'plano']);
    expect(json).toHaveProperty('proximoHorario', null);
  });

  test('o próximo horário sai com id e início em ISO 8601', () => {
    const inicio = new Date('2026-11-09T11:00:00.000Z');
    const json = apresentar.profissional(
      new Profissional({ ...base, planos: [], proximoHorario: { id: 702, inicio } })
    );

    expect(json.proximoHorario).toEqual({ id: 702, inicio: '2026-11-09T11:00:00.000Z' });
  });

  test('na consulta, onde nada disso foi lido, os três campos ficam ausentes', () => {
    const json = apresentar.profissional(new Profissional({ ...base }));

    expect(json).not.toHaveProperty('planos');
    expect(json).not.toHaveProperty('formasDePagamento');
    expect(json).not.toHaveProperty('proximoHorario');
  });

  test('cidade e plano saem com lista fechada de campos', () => {
    expect(apresentar.cidade({ id: 1, nome: 'Quixadá', uf: 'CE', extra: 'x' })).toEqual({
      id: 1,
      nome: 'Quixadá',
      uf: 'CE',
    });
    expect(apresentar.plano({ id: 3, nome: 'Alfa Saúde', extra: 'x' })).toEqual({
      id: 3,
      nome: 'Alfa Saúde',
    });
  });
});
