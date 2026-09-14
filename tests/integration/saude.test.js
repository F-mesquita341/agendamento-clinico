'use strict';

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');

let servidor;

beforeAll(async () => {
  servidor = await iniciar();
});

afterAll(() => parar(servidor));

describe('GET /saude', () => {
  test('responde 200 com o banco conectado', async () => {
    const resposta = await request(servidor).get('/saude');

    expect(resposta.status).toBe(200);
    expect(resposta.body.status).toBe('ok');
    expect(resposta.body.banco).toBe('conectado');
  });
});

describe('rota inexistente', () => {
  test('responde 404 no envelope padrão de erro', async () => {
    const resposta = await request(servidor).get('/rota-que-nao-existe');

    expect(resposta.status).toBe(404);
    expect(resposta.body.erro.codigo).toBe('ROTA_NAO_ENCONTRADA');
    expect(resposta.body.erro).toHaveProperty('mensagem');
    expect(resposta.body.erro).toHaveProperty('acao');
  });
});
