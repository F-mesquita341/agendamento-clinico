'use strict';

/**
 * "Hoje" na validação de data de nascimento.
 *
 * O caso que importa é o fim de noite no Brasil: às 22h30 em Quixadá já é
 * 01h30 do dia seguinte em UTC. Se "hoje" fosse calculado em UTC, a data de
 * amanhã passaria como data de nascimento válida.
 */

const { dataCivil, dataDeNascimento } = require('../../src/interfaces/http/esquemas');

// 16/09/2026 às 22h30 em Quixadá (UTC-3) = 17/09/2026 às 01h30 em UTC.
const NOITE_EM_QUIXADA = new Date('2026-09-17T01:30:00Z');

describe('dataCivil', () => {
  test('usa o dia do fuso da clínica, não o de UTC', () => {
    expect(NOITE_EM_QUIXADA.toISOString().slice(0, 10)).toBe('2026-09-17');
    expect(dataCivil(NOITE_EM_QUIXADA)).toBe('2026-09-16');
  });

  test('em horário comercial, os dois coincidem', () => {
    expect(dataCivil(new Date('2026-09-16T13:00:00Z'))).toBe('2026-09-16');
  });
});

describe('data de nascimento no fim da noite', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOITE_EM_QUIXADA);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a data de amanhã, no horário local, é recusada', () => {
    const resultado = dataDeNascimento().safeParse('2026-09-17');

    expect(resultado.success).toBe(false);
    expect(resultado.error.issues[0].message).toMatch(/futuro/);
  });

  test('a data de hoje, no horário local, é aceita', () => {
    expect(dataDeNascimento().safeParse('2026-09-16').success).toBe(true);
  });
});
