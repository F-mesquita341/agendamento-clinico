'use strict';

/**
 * O período do seed: a recusa precisa vir antes de qualquer escrita, então
 * cada argumento errado tem de ser pego aqui, na função pura.
 */

const { lerPeriodo, LIMITE_DE_DIAS } = require('../../scripts/periodoDoSeed');

// 21:00 de 04/11 em Quixadá já é 05/11 em UTC: o "hoje" tem de ser o da clínica.
const NOITE_DE_04_11 = new Date('2026-11-04T21:00:00-03:00');

describe('lerPeriodo', () => {
  test('sem argumento, os próximos 14 dias, contados no fuso da clínica', () => {
    expect(lerPeriodo([], NOITE_DE_04_11)).toEqual({ hoje: '2026-11-04', ultimoDia: '2026-11-18' });
  });

  test('--ate vale até aquele dia, inclusive', () => {
    expect(lerPeriodo(['--ate', '2026-12-15'], NOITE_DE_04_11)).toEqual({
      hoje: '2026-11-04',
      ultimoDia: '2026-12-15',
    });
  });

  test('--dias conta a partir de hoje', () => {
    expect(lerPeriodo(['--dias', '30'], NOITE_DE_04_11).ultimoDia).toBe('2026-12-04');
  });

  test.each([
    [['--ate', '2026-02-30'], /data AAAA-MM-DD válida/],
    [['--ate', '15/12/2026'], /data AAAA-MM-DD válida/],
    [['--ate', '2026-11-04'], /depois de hoje/],
    [['--ate', '2026-11-01'], /depois de hoje/],
    [['--ate'], /precisa de um valor/],
    [['--ate', '--dias', '3'], /precisa de um valor/],
    [['--dias', '0'], /inteiro positivo/],
    [['--dias', '-5'], /inteiro positivo/],
    [['--dias', '1.5'], /inteiro positivo/],
    [['--ate', '2026-12-15', '--dias', '3'], /não os dois/],
    [['--ate', '2027-12-15'], new RegExp(`passa de ${LIMITE_DE_DIAS} dias`)],
    [['--dias', String(LIMITE_DE_DIAS + 1)], /Confira a data/],
  ])('recusa %j', (args, mensagem) => {
    expect(() => lerPeriodo(args, NOITE_DE_04_11)).toThrow(mensagem);
  });

  test('o teto aceita exatamente o limite', () => {
    expect(() => lerPeriodo(['--dias', String(LIMITE_DE_DIAS)], NOITE_DE_04_11)).not.toThrow();
  });
});
