'use strict';

/**
 * As regras puras das consultas de exemplo: em que dias e horas caem, com que
 * forma de pagamento e com que status. Sem banco.
 */

const { diasUteis, posicao, formaPara, statusPassado } = require('../../scripts/seed-exemplos');

describe('diasUteis', () => {
  test('para trás: os dias úteis antes de hoje, do mais antigo ao mais recente', () => {
    // 19/11/2026 é quinta-feira.
    expect(diasUteis('2026-11-19', -1, 5)).toEqual([
      '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18',
    ]);
  });

  test('para a frente: começa amanhã e pula o fim de semana', () => {
    expect(diasUteis('2026-11-19', +1, 3)).toEqual(['2026-11-20', '2026-11-23', '2026-11-24']);
  });
});

describe('posicao', () => {
  test.each([
    [40, 20],
    [15, 10],
  ])('%i consultas em %i dias: nenhuma divide dia e hora com outra', (total, dias) => {
    const vistas = new Set();
    for (let i = 0; i < total; i += 1) {
      const { dia, hora } = posicao(i, dias);
      const chave = `${dia} ${hora}`;
      expect(vistas.has(chave)).toBe(false);
      vistas.add(chave);
    }
  });

  test('mais consultas do que cabem em duas metades do dia é erro, não sobreposição', () => {
    expect(() => posicao(40, 20)).toThrow(/Consultas demais/);
  });
});

describe('formaPara', () => {
  const so = (aceita) => ({ aceitaApp: false, aceitaClinica: false, planoId: null, ...aceita });

  test('alterna a preferência quando o profissional aceita tudo', () => {
    const tudo = so({ aceitaApp: true, aceitaClinica: true, planoId: 3 });
    expect([0, 1, 2].map((i) => formaPara(i, tudo))).toEqual(['app', 'plano', 'clinica']);
  });

  test.each([
    [so({ aceitaApp: true })],
    [so({ aceitaClinica: true })],
    [so({ aceitaClinica: true, planoId: 3 })],
  ])('só escolhe forma que o profissional aceita (%j)', (prof) => {
    for (let i = 0; i < 6; i += 1) {
      const forma = formaPara(i, prof);
      const aceita = { app: prof.aceitaApp, plano: prof.planoId !== null, clinica: prof.aceitaClinica };
      expect(aceita[forma]).toBe(true);
    }
  });
});

describe('statusPassado', () => {
  const status = Array.from({ length: 40 }, (_, i) => statusPassado(i));

  test('4 faltas, 4 cancelamentos e 32 realizadas em 40', () => {
    const conta = (s) => status.filter((x) => x === s).length;
    expect([conta('nao_compareceu'), conta('cancelada'), conta('realizada')]).toEqual([4, 4, 32]);
  });

  test('as faltas e os cancelamentos caem em pacientes diferentes e em posições diferentes da alternância', () => {
    for (const s of ['nao_compareceu', 'cancelada']) {
      const indices = status.flatMap((x, i) => (x === s ? [i] : []));
      expect(new Set(indices.map((i) => i % 10)).size).toBe(4);
      expect(new Set(indices.map((i) => i % 3)).size).toBeGreaterThan(1);
    }
  });
});
