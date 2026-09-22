'use strict';

/**
 * O texto do lembrete.
 *
 * Dois assuntos: o fuso, que se errado mostra a consulta das 8h como 11h, e a
 * regra de privacidade — a notificação aparece em tela bloqueada e não pode
 * revelar dado de saúde a quem estiver por perto.
 */

const { textoDoLembrete } = require('../../src/domain/Lembrete');

// 21/09/2026, 10:00 em Fortaleza (UTC-3).
const AGORA = new Date('2026-09-21T13:00:00Z');

describe('textoDoLembrete', () => {
  test('consulta de amanhã, no fuso da clínica', () => {
    // 22/09 às 14:30 em Fortaleza é 17:30 UTC. Formatar em UTC diria 17:30.
    const inicio = new Date('2026-09-22T17:30:00Z');

    expect(textoDoLembrete(inicio, AGORA)).toEqual({
      titulo: 'Lembrete de consulta',
      corpo: 'Você tem uma consulta amanhã às 14:30.',
    });
  });

  test('consulta de hoje', () => {
    const inicio = new Date('2026-09-21T20:00:00Z');

    expect(textoDoLembrete(inicio, AGORA).corpo).toBe('Você tem uma consulta hoje às 17:00.');
  });

  test('mais longe que amanhã vira data, não "amanhã"', () => {
    const inicio = new Date('2026-09-25T11:00:00Z');

    expect(textoDoLembrete(inicio, AGORA).corpo).toBe('Você tem uma consulta em 25/09, às 08:00.');
  });

  test('a virada do dia não é decidida por diferença de horas', () => {
    // Faltam menos de 3 horas, mas já é outro dia no fuso da clínica: às 23h de
    // hoje, uma consulta à 1h da manhã é "amanhã". Comparar milissegundos diria
    // "hoje".
    const agora = new Date('2026-09-22T02:00:00Z'); // 21/09, 23:00 em Fortaleza
    const inicio = new Date('2026-09-22T04:00:00Z'); // 22/09, 01:00 em Fortaleza

    expect(textoDoLembrete(inicio, agora).corpo).toBe('Você tem uma consulta amanhã às 01:00.');
  });

  test('não revela especialidade, profissional nem motivo', () => {
    // LGPD, Art. 11. A função nem recebe esses dados — este teste existe para
    // que acrescentá-los amanhã, "para ficar mais útil", derrube a suíte.
    const { titulo, corpo } = textoDoLembrete(new Date('2026-09-22T17:30:00Z'), AGORA);

    expect(`${titulo} ${corpo}`).not.toMatch(
      /cardiolog|dermatolog|pediatr|ortoped|ginecolog|cl[íi]nic|dr\.|dra\.|doutor/i
    );
  });

  test('a função não aceita dados do profissional nem por engano', () => {
    // Assinatura de dois argumentos: não há por onde um nome entrar.
    expect(textoDoLembrete).toHaveLength(2);
  });
});
