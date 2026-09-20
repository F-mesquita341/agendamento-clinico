'use strict';

const { agendar } = require('../../src/infra/agendador');

/** Uma promessa que o teste resolve quando quiser. */
function adiada() {
  let resolver;
  const promessa = new Promise((r) => {
    resolver = r;
  });
  return { promessa, resolver };
}

const esperarTarefas = () => new Promise((r) => setImmediate(r));

describe('agendar', () => {
  test('nunca roda duas vezes ao mesmo tempo', async () => {
    // Mede a propriedade, e não uma contagem: a rodada automática da subida
    // entra ou não na conta conforme a ordem dos temporizadores do Node.
    const lenta = adiada();
    let emExecucao = 0;
    let maximoSimultaneo = 0;
    let chamadas = 0;
    const rotina = agendar(
      async () => {
        chamadas += 1;
        emExecucao += 1;
        maximoSimultaneo = Math.max(maximoSimultaneo, emExecucao);
        await lenta.promessa;
        emExecucao -= 1;
      },
      60_000,
      { nome: 'teste' }
    );

    rotina.rodarAgora();
    rotina.rodarAgora();
    rotina.rodarAgora();
    await esperarTarefas();
    await esperarTarefas();

    // Enquanto a primeira não termina, as outras são puladas, não empilhadas.
    expect(chamadas).toBe(1);
    expect(maximoSimultaneo).toBe(1);

    lenta.resolver();
    await esperarTarefas();
    await rotina.rodarAgora();
    expect(maximoSimultaneo).toBe(1);
    rotina.parar();
  });

  test('um erro é registrado e não impede a rodada seguinte', async () => {
    const erroOriginal = console.error;
    const registrados = [];
    console.error = (...args) => registrados.push(args.join(' '));
    try {
      let chamadas = 0;
      const rotina = agendar(
        async () => {
          chamadas += 1;
          if (chamadas === 1) throw new Error('banco fora do ar');
        },
        60_000,
        { nome: 'expiração' }
      );

      await rotina.rodarAgora();
      await rotina.rodarAgora();

      expect(chamadas).toBe(2);
      expect(registrados.join('\n')).toMatch(/expiração.*banco fora do ar/);
      rotina.parar();
    } finally {
      console.error = erroOriginal;
    }
  });

  test('depois de parar, não roda mais', async () => {
    let chamadas = 0;
    const rotina = agendar(async () => {
      chamadas += 1;
    }, 60_000);

    rotina.parar();
    await rotina.rodarAgora();
    await esperarTarefas();

    expect(chamadas).toBe(0);
  });

  test('entrega o resultado de cada rodada', async () => {
    const resultados = [];
    const rotina = agendar(async () => ({ expiradas: 2 }), 60_000, {
      aoTerminar: (r) => resultados.push(r),
    });

    await rotina.rodarAgora();
    rotina.parar();

    expect(resultados).toContainEqual({ expiradas: 2 });
  });
});
