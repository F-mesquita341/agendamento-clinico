'use strict';

/**
 * O catálogo de demonstração ampliado e as consultas de exemplo, de ponta a
 * ponta, como processos — na ordem em que rodam na homologação —, contra o
 * banco de teste.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');
const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { limpar } = require('../helpers/semente');
const { consultar } = require('../../src/infra/db/pool');
const { diasUteis } = require('../../scripts/seed-exemplos');
const { hojeNaClinica } = require('../../scripts/periodoDoSeed');

const SEED = path.resolve(__dirname, '../../scripts/seed.js');
const DEMONSTRACAO = path.resolve(__dirname, '../../scripts/seed-demonstracao.js');
const EXEMPLOS = path.resolve(__dirname, '../../scripts/seed-exemplos.js');

function rodar(script, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, NODE_ENV: 'test', ...env }, timeout: 120_000 },
      (erro, stdout, stderr) => resolve({ codigo: erro ? erro.code : 0, stdout, stderr })
    );
  });
}

async function osTres() {
  expect((await rodar(SEED, ['--dias', '14'])).codigo).toBe(0);
  expect((await rodar(DEMONSTRACAO, ['--dias', '14'])).codigo).toBe(0);
  return rodar(EXEMPLOS);
}

async function exemplos() {
  const { rows } = await consultar(
    `SELECT c.id, c.status::text AS status, c.forma_de_pagamento AS forma, c.plano_id,
            c.reserva_expira_em, c.motivo_cancelamento, h.status::text AS horario,
            h.inicio, ci.nome AS cidade, p.registro_conselho AS registro,
            (SELECT count(*)::int FROM pagamento pg WHERE pg.consulta_id = c.id) AS pagamentos,
            (SELECT count(*)::int FROM pagamento pg
              WHERE pg.consulta_id = c.id AND pg.status = 'aprovado' AND pg.ambiente = 'sandbox') AS aprovados
       FROM consulta c
       JOIN paciente pa ON pa.id = c.paciente_id
       JOIN horario h ON h.id = c.horario_id
       JOIN profissional p ON p.id = h.profissional_id
       JOIN clinica cl ON cl.id = p.clinica_id
       LEFT JOIN cidade ci ON ci.id = cl.cidade_id
      WHERE pa.firebase_uid LIKE 'demonstracao-paciente-%'
      ORDER BY c.id`
  );
  return rows;
}

let servidor;

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(() => limpar());

afterAll(() => parar(servidor));

test('o catálogo ampliado: três clínicas por cidade, 20 profissionais, 10 especialidades', async () => {
  await osTres();

  const cidades = (await request(servidor).get('/cidades')).body.cidades;
  expect(cidades.map((c) => c.nome)).toEqual(['Fortaleza', 'Quixadá', 'Quixeramobim']);

  const porCidade = {};
  for (const c of cidades) {
    const r = await request(servidor).get(`/profissionais?cidade=${c.id}&limite=100`);
    porCidade[c.nome] = r.body.profissionais;
  }
  expect(porCidade['Quixadá']).toHaveLength(11);
  expect(porCidade['Quixeramobim']).toHaveLength(7);
  expect(porCidade.Fortaleza).toHaveLength(2);
  for (const nome of ['Quixadá', 'Quixeramobim']) {
    expect(new Set(porCidade[nome].map((p) => p.clinica.id)).size).toBe(3);
  }

  const especialidades = (await request(servidor).get('/especialidades')).body.especialidades;
  expect(especialidades.map((e) => e.nome)).toEqual(
    expect.arrayContaining(['Endocrinologia', 'Oftalmologia', 'Otorrinolaringologia', 'Psiquiatria'])
  );
  expect(especialidades).toHaveLength(10);

  // Os três casos do card continuam, mesmo depois das consultas de exemplo.
  const todos = Object.fromEntries(Object.values(porCidade).flat().map((p) => [p.nome, p]));
  expect(todos['Ana Beatriz Nogueira'].planos).toEqual([]);
  expect(todos['Carlos Eduardo Timbó'].planos.length).toBeGreaterThanOrEqual(3);
  expect(todos['Íris Monteiro Lopes']).toHaveProperty('proximoHorario', null);
  expect(todos['Paula Ribeiro Maia'].formasDePagamento).toEqual(['plano', 'clinica']);
}, 300_000);

test('as consultas de exemplo: histórico e próximas, sem pendência, sem Fortaleza, sem auditoria', async () => {
  const r = await osTres();
  expect(r.codigo).toBe(0);
  expect(r.stdout).toMatch(/40 consultas passadas e 15 futuras criadas/);

  const cs = await exemplos();
  expect(cs).toHaveLength(55);
  const conta = (f) => cs.filter(f).length;
  expect(conta((c) => c.status === 'realizada')).toBe(32);
  expect(conta((c) => c.status === 'nao_compareceu')).toBe(4);
  expect(conta((c) => c.status === 'cancelada')).toBe(4);
  expect(conta((c) => c.status === 'confirmada')).toBe(15);
  expect(conta((c) => c.status === 'pendente_pagamento')).toBe(0);
  expect(new Set(cs.map((c) => c.forma))).toEqual(new Set(['app', 'plano', 'clinica']));

  // Só Quixadá e Quixeramobim; nada da Íris (o caso "sem horário livre").
  expect(new Set(cs.map((c) => c.cidade))).toEqual(new Set(['Quixadá', 'Quixeramobim']));
  expect(conta((c) => c.registro === 'CRM-CE 89012')).toBe(0);

  const agora = Date.now();
  for (const c of cs) {
    expect(c.reserva_expira_em).toBeNull();
    if (c.status === 'confirmada') expect(c.inicio.getTime()).toBeGreaterThan(agora);
    else expect(c.inicio.getTime()).toBeLessThan(agora);
    // O horário acompanha a consulta: reservado se ativa, de volta à grade se cancelada.
    expect(c.horario).toBe(c.status === 'cancelada' ? 'disponivel' : 'reservado');
    expect(c.motivo_cancelamento).toBe(c.status === 'cancelada' ? 'paciente' : null);
    // Pagamento aprovado em sandbox só para quem pagou pelo app e não cancelou.
    const pagou = c.forma === 'app' && c.status !== 'cancelada';
    expect([c.pagamentos, c.aprovados]).toEqual(pagou ? [1, 1] : [0, 0]);
  }

  const { rows: auditoria } = await consultar('SELECT count(*)::int AS n FROM auditoria');
  expect(auditoria[0].n).toBe(0);

  const { rows: pacientes } = await consultar(
    `SELECT count(*)::int AS n FROM paciente
      WHERE firebase_uid LIKE 'demonstracao-paciente-%' AND email LIKE '%@exemplo.invalid'`
  );
  expect(pacientes[0].n).toBe(10);
}, 300_000);

test('rodar de novo, mesmo com os outros dois antes, não cria nem muda nada', async () => {
  await osTres();
  const antes = await exemplos();

  const deNovo = await rodar(EXEMPLOS);
  expect(deNovo.codigo).toBe(0);
  expect(deNovo.stdout).toMatch(/já tinham 55 consultas; nada foi criado/);

  await rodar(SEED, ['--dias', '14']);
  await rodar(DEMONSTRACAO, ['--dias', '14']);
  await rodar(EXEMPLOS);

  expect(await exemplos()).toEqual(antes);
  const { rows } = await consultar(
    `SELECT count(*)::int AS n FROM paciente WHERE firebase_uid LIKE 'demonstracao-paciente-%'`
  );
  expect(rows[0].n).toBe(10);
}, 400_000);

test('não toca nas consultas de outras pessoas: pula o horário delas', async () => {
  expect((await rodar(SEED, ['--dias', '14'])).codigo).toBe(0);
  expect((await rodar(DEMONSTRACAO, ['--dias', '14'])).codigo).toBe(0);

  // Uma conta de teste do aplicativo já reservou o primeiro horário futuro e
  // tinha o primeiro passado — exatamente os que o seed escolheria.
  const { rows: pa } = await consultar(
    `INSERT INTO paciente (firebase_uid, nome, email, consentimento_versao, consentimento_em)
     VALUES ('uid-conta-de-teste', 'Conta de Teste', 'teste@example.com', '2026-09-v2', now())
     RETURNING id`
  );
  const { rows: joana } = await consultar(
    `SELECT id FROM profissional WHERE registro_conselho = 'CRM-CE 000101'`
  );
  const hoje = hojeNaClinica(new Date());
  const amanha = diasUteis(hoje, +1, 10)[0];
  const passado = diasUteis(hoje, -1, 20)[0];
  const { rows: hs } = await consultar(
    `WITH futuro AS (
       UPDATE horario SET status = 'reservado', versao = versao + 1
        WHERE profissional_id = $1 AND inicio = ($2::timestamp AT TIME ZONE 'America/Fortaleza')
        RETURNING id, inicio, fim),
     passado AS (
       INSERT INTO horario (profissional_id, inicio, fim, status)
       SELECT $1, m, m + INTERVAL '30 minutes', 'reservado'
         FROM (SELECT ($3::timestamp AT TIME ZONE 'America/Fortaleza') AS m) t
       RETURNING id, inicio, fim)
     SELECT * FROM futuro UNION ALL SELECT * FROM passado`,
    [joana[0].id, `${amanha} 08:00`, `${passado} 08:00`]
  );
  expect(hs).toHaveLength(2);
  for (const h of hs) {
    await consultar(
      `INSERT INTO consulta (paciente_id, horario_id, status, valor_centavos, periodo, forma_de_pagamento, plano_id)
       VALUES ($1, $2, 'confirmada', 23000, tstzrange($3, $4, '[)'), 'clinica', NULL)`,
      [pa[0].id, h.id, h.inicio, h.fim]
    );
  }
  const { rows: antes } = await consultar(
    `SELECT c.*, h.status AS horario_status, h.versao FROM consulta c JOIN horario h ON h.id = c.horario_id
      WHERE c.paciente_id = $1 ORDER BY c.id`,
    [pa[0].id]
  );

  const r = await rodar(EXEMPLOS);
  expect(r.codigo).toBe(0);
  expect(r.stdout).toMatch(/39 consultas passadas e 14 futuras criadas; 1 futuras puladas/);

  const { rows: depois } = await consultar(
    `SELECT c.*, h.status AS horario_status, h.versao FROM consulta c JOIN horario h ON h.id = c.horario_id
      WHERE c.paciente_id = $1 ORDER BY c.id`,
    [pa[0].id]
  );
  expect(depois).toEqual(antes);
}, 300_000);

test('recusa o banco da coleta antes de qualquer escrita', async () => {
  const r = await rodar(EXEMPLOS, [], {
    DATABASE_URL_TESTE: 'postgresql://usuario:senha@localhost:1/agendamento_coleta',
  });
  expect(r.codigo).toBe(1);
  expect(r.stderr).toMatch(/Recusado: .*agendamento_coleta/);
  expect(r.stderr).toMatch(/Nada foi escrito/);
  expect(r.stdout).not.toMatch(/Consultas de exemplo em/);
}, 60_000);
