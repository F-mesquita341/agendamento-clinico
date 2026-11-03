'use strict';

/**
 * A trava do catálogo de demonstração: dado fictício não pode chegar ao banco
 * da coleta. Decide pelo nome do banco, antes de qualquer escrita.
 */

const { bancoProibido } = require('../../scripts/seed-demonstracao');

const url = (banco) => `postgresql://usuario:senha@exemplo.neon.tech/${banco}?sslmode=require`;

describe('bancoProibido', () => {
  test.each([
    'agendamento_producao',
    'agendamento_coleta',
    'AGENDAMENTO_PRODUCAO',
    'coleta',
  ])('recusa %s', (banco) => {
    expect(bancoProibido(url(banco))).toBe(true);
  });

  test.each(['agendamento_homologacao', 'agendamento', 'agendamento_teste'])('aceita %s', (banco) => {
    expect(bancoProibido(url(banco))).toBe(false);
  });

  test('URL ilegível ou sem banco também é recusada', () => {
    expect(bancoProibido('não é uma url')).toBe(true);
    expect(bancoProibido('postgresql://usuario:senha@exemplo.neon.tech/')).toBe(true);
    expect(bancoProibido(undefined)).toBe(true);
  });
});
