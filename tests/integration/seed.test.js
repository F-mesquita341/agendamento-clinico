'use strict';

/**
 * O seed de ponta a ponta, como processo — do jeito que roda em produção —,
 * contra o banco de teste (NODE_ENV=test faz o config usar DATABASE_URL_TESTE).
 */

const { execFile } = require('node:child_process');
const path = require('node:path');
const { consultar } = require('../../src/infra/db/pool');
const { limpar, semearPacientes } = require('../helpers/semente');
const { lerPeriodo } = require('../../scripts/periodoDoSeed');

const SEED = path.resolve(__dirname, '../../scripts/seed.js');

function rodarSeed(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SEED, ...args],
      { env: { ...process.env, NODE_ENV: 'test' }, timeout: 120_000 },
      (erro, stdout, stderr) => resolve({ codigo: erro ? erro.code : 0, stdout, stderr })
    );
  });
}

/** Dias úteis de amanhã até `ultimoDia`, inclusive, como 'AAAA-MM-DD'. */
function diasUteis(hoje, ultimoDia) {
  const dias = [];
  const d = new Date(`${hoje}T00:00:00Z`);
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (iso > ultimoDia) return dias;
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dias.push(iso);
  }
}

async function horariosPorDia() {
  const { rows } = await consultar(`
    SELECT to_char(inicio AT TIME ZONE 'America/Fortaleza', 'YYYY-MM-DD') AS dia, count(*)::int AS n
      FROM horario GROUP BY 1 ORDER BY 1`);
  return Object.fromEntries(rows.map((r) => [r.dia, r.n]));
}

beforeEach(() => limpar());

describe('npm run seed', () => {
  test('argumento inválido sai com erro e não escreve nada', async () => {
    const r = await rodarSeed(['--ate', '2026-02-30']);

    expect(r.codigo).toBe(1);
    expect(r.stderr).toMatch(/Nada foi escrito/);
    const { rows } = await consultar(
      'SELECT (SELECT count(*) FROM clinica)::int AS c, (SELECT count(*) FROM horario)::int AS h'
    );
    expect(rows[0]).toEqual({ c: 0, h: 0 });
  }, 120_000);

  test('--dias cria a grade de amanhã até o último dia, e nada além', async () => {
    const { hoje, ultimoDia } = lerPeriodo(['--dias', '10']);

    const r = await rodarSeed(['--dias', '10']);

    expect(r.codigo).toBe(0);
    // Mostra em que banco mexeu, sem usuário nem senha.
    expect(r.stdout).toMatch(/Semeando .+\//);
    expect(r.stdout).not.toMatch(/postgres(ql)?:\/\//);

    const esperado = Object.fromEntries(diasUteis(hoje, ultimoDia).map((dia) => [dia, 5 * 14]));
    expect(await horariosPorDia()).toEqual(esperado);
  }, 120_000);

  test('rodar de novo com período maior só acrescenta, e não toca consulta', async () => {
    await rodarSeed(['--dias', '5']);
    const pacientes = await semearPacientes();
    // Uma consulta num horário da primeira rodada.
    const { rows: [h] } = await consultar(
      `UPDATE horario SET status = 'reservado', versao = versao + 1
        WHERE id = (SELECT min(id) FROM horario) RETURNING id, versao`
    );
    const { rows: [c] } = await consultar(
      `INSERT INTO consulta (paciente_id, horario_id, status, valor_centavos, periodo)
       SELECT $1, id, 'confirmada', 15000, tstzrange(inicio, fim) FROM horario WHERE id = $2
       RETURNING id`,
      [pacientes.a, h.id]
    );
    const antes = Object.values(await horariosPorDia()).reduce((a, b) => a + b, 0);

    const r = await rodarSeed(['--dias', '12']);

    expect(r.codigo).toBe(0);
    const depois = Object.values(await horariosPorDia()).reduce((a, b) => a + b, 0);
    expect(depois).toBeGreaterThan(antes);
    const { rows: [hd] } = await consultar('SELECT status, versao FROM horario WHERE id = $1', [h.id]);
    expect(hd).toEqual({ status: 'reservado', versao: h.versao });
    const { rows: [cd] } = await consultar('SELECT status FROM consulta WHERE id = $1', [c.id]);
    expect(cd.status).toBe('confirmada');
    // E a mesma rodada de novo não cria nada.
    const repetida = await rodarSeed(['--dias', '12']);
    expect(repetida.stdout).toMatch(/\b0 horários criados/);
  }, 240_000);
});
