'use strict';

/**
 * Versão 2, Etapa 20: cidade, planos, formas de pagamento e próximo horário
 * no catálogo, contra o PostgreSQL real. Sobre a semente comum:
 *
 *   Quixadá   — a clínica da semente: José (cardiologia; planos Alfa, Beta e
 *               Gama) e Inês (pediatria; sem plano; aceita pagar na clínica)
 *   Fortaleza — Bruno (cardiologia; plano Beta; só na clínica, não pelo app;
 *               sem horário nenhum)
 *   Sobral    — só um profissional inativo, com o plano Delta
 */

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { semear } = require('../helpers/semente');
const { consultar } = require('../../src/infra/db/pool');

let servidor;
let dados;
let v2;

async function inserir(sql, valores) {
  const { rows } = await consultar(sql, valores);
  return Number(rows[0].id);
}

async function semearV2() {
  const quixada = await inserir(`INSERT INTO cidade (nome, uf) VALUES ('Quixadá', 'CE') RETURNING id`);
  const fortaleza = await inserir(`INSERT INTO cidade (nome, uf) VALUES ('Fortaleza', 'CE') RETURNING id`);
  const sobral = await inserir(`INSERT INTO cidade (nome, uf) VALUES ('Sobral', 'CE') RETURNING id`);

  await consultar(
    `UPDATE clinica SET cidade_id = $2, latitude = -4.97, longitude = -39.01 WHERE id = $1`,
    [dados.clinicaId, quixada]
  );
  const clinicaFortaleza = await inserir(
    `INSERT INTO clinica (nome, cnpj, cidade_id) VALUES ('Clínica Fortaleza', '22.222.222/0001-22', $1) RETURNING id`,
    [fortaleza]
  );
  const clinicaSobral = await inserir(
    `INSERT INTO clinica (nome, cnpj, cidade_id) VALUES ('Clínica Sobral', '33.333.333/0001-33', $1) RETURNING id`,
    [sobral]
  );

  const bruno = await inserir(
    `INSERT INTO profissional
       (clinica_id, especialidade_id, nome, registro_conselho, valor_consulta_centavos,
        aceita_pagamento_no_app, aceita_pagar_na_clinica)
     VALUES ($1, $2, 'Bruno Ribeiro', 'CRM-CE 44444', 30000, false, true) RETURNING id`,
    [clinicaFortaleza, dados.especialidades.cardiologia]
  );
  const inativoDeSobral = await inserir(
    `INSERT INTO profissional
       (clinica_id, especialidade_id, nome, registro_conselho, valor_consulta_centavos, ativo)
     VALUES ($1, $2, 'Saulo Inativo', 'CRM-CE 55555', 20000, false) RETURNING id`,
    [clinicaSobral, dados.especialidades.pediatria]
  );
  await consultar(`UPDATE profissional SET aceita_pagar_na_clinica = true WHERE id = $1`, [
    dados.profissionais.ines,
  ]);

  const plano = {};
  for (const nome of ['Gama Mais', 'Alfa Saúde', 'Beta Vida', 'Delta Plano']) {
    plano[nome.split(' ')[0].toLowerCase()] = await inserir(
      `INSERT INTO plano_de_saude (nome) VALUES ($1) RETURNING id`,
      [nome]
    );
  }
  const aceitar = (profissionalId, planoId) =>
    consultar(`INSERT INTO profissional_plano (profissional_id, plano_id) VALUES ($1, $2)`, [
      profissionalId,
      planoId,
    ]);
  await aceitar(dados.profissionais.jose, plano.gama);
  await aceitar(dados.profissionais.jose, plano.alfa);
  await aceitar(dados.profissionais.jose, plano.beta);
  await aceitar(bruno, plano.beta);
  await aceitar(inativoDeSobral, plano.delta);

  return { cidade: { quixada, fortaleza, sobral }, plano, bruno };
}

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(async () => {
  dados = await semear();
  v2 = await semearV2();
});

afterAll(() => parar(servidor));

const nomes = (r) => r.body.profissionais.map((p) => p.nome);

describe('GET /cidades', () => {
  test('só as cidades com profissional ativo, em ordem alfabética, com cache', async () => {
    const r = await request(servidor).get('/cidades');

    expect(r.status).toBe(200);
    expect(r.body.cidades).toEqual([
      { id: v2.cidade.fortaleza, nome: 'Fortaleza', uf: 'CE' },
      { id: v2.cidade.quixada, nome: 'Quixadá', uf: 'CE' },
    ]);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
  });
});

describe('GET /planos', () => {
  test('só os planos com profissional ativo, em ordem alfabética, com cache', async () => {
    const r = await request(servidor).get('/planos');

    expect(r.status).toBe(200);
    expect(r.body.planos).toEqual([
      { id: v2.plano.alfa, nome: 'Alfa Saúde' },
      { id: v2.plano.beta, nome: 'Beta Vida' },
      { id: v2.plano.gama, nome: 'Gama Mais' },
    ]);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
  });
});

describe('GET /profissionais — filtros novos', () => {
  test('por cidade', async () => {
    const r = await request(servidor).get(`/profissionais?cidade=${v2.cidade.fortaleza}`);
    expect(nomes(r)).toEqual(['Bruno Ribeiro']);

    const q = await request(servidor).get(`/profissionais?cidade=${v2.cidade.quixada}`);
    expect(nomes(q)).toEqual(['Inês Cardoso Lima', 'José Antônio Ferreira']);
  });

  test('por plano', async () => {
    const r = await request(servidor).get(`/profissionais?plano=${v2.plano.beta}`);
    expect(nomes(r)).toEqual(['Bruno Ribeiro', 'José Antônio Ferreira']);
  });

  test('combinados entre si e com os de antes', async () => {
    const r = await request(servidor).get(
      `/profissionais?plano=${v2.plano.beta}&cidade=${v2.cidade.quixada}&especialidade=${dados.especialidades.cardiologia}`
    );
    expect(nomes(r)).toEqual(['José Antônio Ferreira']);

    const q = await request(servidor).get(`/profissionais?plano=${v2.plano.beta}&q=bru`);
    expect(nomes(q)).toEqual(['Bruno Ribeiro']);
  });

  test('id inexistente devolve lista vazia, e valor inválido é recusado', async () => {
    const vazia = await request(servidor).get('/profissionais?cidade=999999&plano=999999');
    expect(vazia.status).toBe(200);
    expect(vazia.body.profissionais).toEqual([]);
    expect(vazia.body.paginacao.total).toBe(0);

    for (const consulta of ['cidade=abc', 'plano=0', 'cidade=-1']) {
      const r = await request(servidor).get(`/profissionais?${consulta}`);
      expect(r.status).toBe(422);
      expect(r.body.erro.codigo).toBe('DADOS_INVALIDOS');
    }
  });

  test('o profissional com três planos aparece uma vez só, e o total não infla', async () => {
    const r = await request(servidor).get('/profissionais');

    expect(nomes(r)).toEqual(['Bruno Ribeiro', 'Inês Cardoso Lima', 'José Antônio Ferreira']);
    expect(r.body.paginacao.total).toBe(3);

    const pagina = await request(servidor).get('/profissionais?limite=1&pagina=3');
    expect(nomes(pagina)).toEqual(['José Antônio Ferreira']);
    expect(pagina.body.paginacao).toMatchObject({ total: 3, paginas: 3 });
  });
});

describe('GET /profissionais — campos novos', () => {
  const daLista = async (nome) =>
    (await request(servidor).get('/profissionais')).body.profissionais.find((p) => p.nome === nome);

  test('planos em ordem alfabética e formas na ordem app, plano, clínica', async () => {
    const jose = await daLista('José Antônio Ferreira');
    const ines = await daLista('Inês Cardoso Lima');
    const bruno = await daLista('Bruno Ribeiro');

    expect(jose.planos.map((p) => p.nome)).toEqual(['Alfa Saúde', 'Beta Vida', 'Gama Mais']);
    expect(jose.formasDePagamento).toEqual(['app', 'plano']);
    expect(ines.planos).toEqual([]);
    expect(ines.formasDePagamento).toEqual(['app', 'clinica']);
    expect(bruno.formasDePagamento).toEqual(['plano', 'clinica']);
  });

  test('a clínica traz a cidade e as coordenadas, ou null', async () => {
    const jose = await daLista('José Antônio Ferreira');
    const bruno = await daLista('Bruno Ribeiro');

    expect(jose.clinica).toMatchObject({
      cidade: { id: v2.cidade.quixada, nome: 'Quixadá', uf: 'CE' },
      latitude: -4.97,
      longitude: -39.01,
    });
    expect(bruno.clinica).toMatchObject({
      cidade: { id: v2.cidade.fortaleza, nome: 'Fortaleza', uf: 'CE' },
      latitude: null,
      longitude: null,
    });
  });

  test('o próximo horário é o livre mais cedo que ainda não começou', async () => {
    // O José tem um livre no passado, o de amanhã, o de depois de amanhã e um
    // reservado: vale o de amanhã.
    const jose = await daLista('José Antônio Ferreira');
    expect(jose.proximoHorario.id).toBe(dados.horarios.amanha);
    expect(jose.proximoHorario.inicio).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    // Reservado o de amanhã, passa a valer o de depois de amanhã.
    await consultar(`UPDATE horario SET status = 'reservado' WHERE id = $1`, [dados.horarios.amanha]);
    expect((await daLista('José Antônio Ferreira')).proximoHorario.id).toBe(
      dados.horarios.comVersao7
    );
  });

  test('sem horário livre, o próximo horário vem presente e nulo', async () => {
    const bruno = await daLista('Bruno Ribeiro');

    expect(bruno).toHaveProperty('proximoHorario', null);
  });

  test('o detalhe traz os mesmos campos', async () => {
    const r = await request(servidor).get(`/profissionais/${v2.bruno}`);

    expect(r.status).toBe(200);
    expect(r.body.profissional).toMatchObject({
      planos: [{ id: v2.plano.beta, nome: 'Beta Vida' }],
      formasDePagamento: ['plano', 'clinica'],
      proximoHorario: null,
      clinica: { cidade: { nome: 'Fortaleza' } },
    });
  });
});
