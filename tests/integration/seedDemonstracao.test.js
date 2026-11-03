'use strict';

/**
 * O catálogo de demonstração da versão 2, de ponta a ponta, como processo —
 * do jeito que roda na homologação —, contra o banco de teste.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');
const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { limpar } = require('../helpers/semente');

const SEED = path.resolve(__dirname, '../../scripts/seed.js');
const DEMONSTRACAO = path.resolve(__dirname, '../../scripts/seed-demonstracao.js');

function rodar(script, args = ['--dias', '10']) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, NODE_ENV: 'test' }, timeout: 120_000 },
      (erro, stdout, stderr) => resolve({ codigo: erro ? erro.code : 0, stdout, stderr })
    );
  });
}

let servidor;

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(() => limpar());

afterAll(() => parar(servidor));

async function catalogo() {
  const r = await request(servidor).get('/profissionais?limite=100');
  return Object.fromEntries(r.body.profissionais.map((p) => [p.nome, p]));
}

test('cria as três cidades, os planos e os três casos do card', async () => {
  expect((await rodar(SEED)).codigo).toBe(0);
  const r = await rodar(DEMONSTRACAO);
  expect(r.codigo).toBe(0);
  expect(r.stdout).toMatch(/Catálogo de demonstração em .+\/agendamento_teste/);

  const cidades = (await request(servidor).get('/cidades')).body.cidades.map((c) => c.nome);
  expect(cidades).toEqual(['Fortaleza', 'Quixadá', 'Quixeramobim']);
  expect((await request(servidor).get('/planos')).body.planos).toHaveLength(4);

  const p = await catalogo();
  expect(p['Ana Beatriz Nogueira'].planos).toEqual([]);
  expect(p['Carlos Eduardo Timbó'].planos.length).toBeGreaterThanOrEqual(3);
  expect(p['Íris Monteiro Lopes']).toHaveProperty('proximoHorario', null);
  expect(p['Gabriela Matos Pinheiro'].proximoHorario).not.toBeNull();
  expect(p['Heitor Sampaio Brito'].formasDePagamento).toEqual(['plano', 'clinica']);
  expect(p['Fernanda Alencar Sá'].formasDePagamento).toEqual(['app', 'clinica']);
  expect(p['Carlos Eduardo Timbó'].clinica.cidade.nome).toBe('Quixadá');
}, 240_000);

test('é idempotente, e rodar os dois de novo, na ordem, restaura o caso sem horário', async () => {
  await rodar(SEED);
  await rodar(DEMONSTRACAO);
  const antes = await catalogo();

  // O seed base de novo devolve horários à Íris...
  await rodar(SEED);
  expect((await catalogo())['Íris Monteiro Lopes'].proximoHorario).not.toBeNull();

  // ...e a demonstração de novo os retira, sem duplicar nada.
  await rodar(DEMONSTRACAO);
  const depois = await catalogo();
  expect(depois['Íris Monteiro Lopes']).toHaveProperty('proximoHorario', null);
  expect(Object.keys(depois).sort()).toEqual(Object.keys(antes).sort());
  expect(depois['Carlos Eduardo Timbó'].planos).toEqual(antes['Carlos Eduardo Timbó'].planos);
  expect((await request(servidor).get('/cidades')).body.cidades).toHaveLength(3);
}, 300_000);
