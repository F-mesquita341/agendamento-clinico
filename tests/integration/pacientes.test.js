'use strict';

/**
 * Autenticação e perfil, de ponta a ponta contra o PostgreSQL real.
 *
 * O token é verificado pelo verificador falso (tests/helpers/verificadorFalso),
 * que cumpre o mesmo contrato do Firebase. Todo o resto é real: rotas,
 * middlewares, casos de uso, adaptador, restrições do banco e auditoria.
 */

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { limpar } = require('../helpers/semente');
const { tokenDe, TOKEN_EXPIRADO } = require('../helpers/verificadorFalso');
const { consultar } = require('../../src/infra/db/pool');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../../src/domain/Paciente');

const A = { uid: 'uid-paciente-a', email: 'paciente.a@example.com' };
const B = { uid: 'uid-paciente-b', email: 'paciente.b@example.com' };
const ACEITE = { aceito: true, versao: VERSAO_TERMO_CONSENTIMENTO };

const comoA = { Authorization: `Bearer ${tokenDe(A.uid, A.email)}` };
const comoB = { Authorization: `Bearer ${tokenDe(B.uid, B.email)}` };

let servidor;

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(() => limpar());

afterAll(() => parar(servidor));

function cadastrar(cabecalhos, corpo = { nome: 'Pessoa de Teste', consentimento: ACEITE }) {
  return request(servidor).post('/pacientes').set(cabecalhos).send(corpo);
}

async function contarPacientes() {
  const { rows } = await consultar('SELECT count(*)::int AS n FROM paciente');
  return rows[0].n;
}

describe('autenticação', () => {
  test.each([
    ['sem cabeçalho', {}],
    ['esquema diferente de Bearer', { Authorization: `Basic ${tokenDe(A.uid, A.email)}` }],
    ['Bearer sem token', { Authorization: 'Bearer' }],
    ['token com espaço extra', { Authorization: `Bearer ${tokenDe(A.uid, A.email)} sobra` }],
    ['token inválido', { Authorization: 'Bearer nao-e-um-token' }],
  ])('%s → 401', async (_rotulo, cabecalhos) => {
    const r = await request(servidor).get('/pacientes/me').set(cabecalhos);

    expect(r.status).toBe(401);
    expect(r.body.erro.codigo).toBe('NAO_AUTENTICADO');
  });

  test('token expirado → 401 com ação de renovar, não de refazer login', async () => {
    const r = await request(servidor)
      .get('/pacientes/me')
      .set({ Authorization: `Bearer ${TOKEN_EXPIRADO}` });

    expect(r.status).toBe(401);
    expect(r.body.erro).toMatchObject({ codigo: 'SESSAO_EXPIRADA', acao: 'renovar_token' });
  });

  test('conta autenticada sem cadastro → 404 com ação de completar cadastro', async () => {
    const r = await request(servidor).get('/pacientes/me').set(comoA);

    expect(r.status).toBe(404);
    expect(r.body.erro).toMatchObject({
      codigo: 'PERFIL_NAO_CADASTRADO',
      acao: 'completar_cadastro',
    });
  });

  test('respostas de perfil não ficam em cache', async () => {
    await cadastrar(comoA);
    const r = await request(servidor).get('/pacientes/me').set(comoA);

    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /pacientes', () => {
  test('cadastra e grava o consentimento com versão e horário do servidor', async () => {
    const antes = Date.now();
    const r = await cadastrar(comoA, {
      nome: '  Maria   da Silva ',
      telefone: '(88) 99999-8888',
      dataNascimento: '1990-05-17',
      consentimento: ACEITE,
    });

    expect(r.status).toBe(201);
    expect(r.headers.location).toBe('/pacientes/me');
    expect(r.body.paciente).toMatchObject({
      nome: 'Maria da Silva',
      email: A.email,
      telefone: '88999998888',
      dataNascimento: '1990-05-17',
      consentimento: { versao: VERSAO_TERMO_CONSENTIMENTO },
    });
    expect(r.body.paciente).not.toHaveProperty('firebaseUid');

    const { rows } = await consultar(
      'SELECT consentimento_versao, consentimento_em FROM paciente WHERE firebase_uid = $1',
      [A.uid]
    );
    expect(rows[0].consentimento_versao).toBe(VERSAO_TERMO_CONSENTIMENTO);
    expect(new Date(rows[0].consentimento_em).getTime()).toBeGreaterThanOrEqual(antes - 5000);
  });

  test('sem consentimento → 422 e nenhuma linha criada', async () => {
    const r = await cadastrar(comoA, { nome: 'Maria da Silva' });

    expect(r.status).toBe(422);
    expect(r.body.erro).toMatchObject({
      codigo: 'CONSENTIMENTO_OBRIGATORIO',
      acao: 'exibir_termo',
    });
    expect(await contarPacientes()).toBe(0);
  });

  test('consentimento recusado ou de versão antiga → 422', async () => {
    for (const consentimento of [
      { aceito: false, versao: VERSAO_TERMO_CONSENTIMENTO },
      { aceito: true, versao: '2020-01-v0' },
    ]) {
      const r = await cadastrar(comoA, { nome: 'Maria', consentimento });
      expect(r.status).toBe(422);
      expect(r.body.erro.codigo).toBe('CONSENTIMENTO_OBRIGATORIO');
    }
    expect(await contarPacientes()).toBe(0);
  });

  test('cadastro repetido da mesma conta → 409', async () => {
    await cadastrar(comoA);
    const r = await cadastrar(comoA);

    expect(r.status).toBe(409);
    expect(r.body.erro.codigo).toBe('PACIENTE_JA_CADASTRADO');
  });

  test('dez cadastros simultâneos da mesma conta → exatamente um vence', async () => {
    // Todos passam juntos pela checagem prévia do caso de uso; quem decide é a
    // restrição UNIQUE do banco, traduzida em 409 pelo adaptador.
    const respostas = await Promise.all(Array.from({ length: 10 }, () => cadastrar(comoA)));
    const status = respostas.map((r) => r.status).sort();

    expect(status.filter((s) => s === 201)).toHaveLength(1);
    expect(status.filter((s) => s === 409)).toHaveLength(9);
    expect(await contarPacientes()).toBe(1);
  });

  test('e-mail ou uid no corpo são recusados — a identidade vem do token', async () => {
    const r = await cadastrar(comoA, {
      nome: 'Maria',
      email: 'outra.pessoa@example.com',
      firebaseUid: B.uid,
      consentimento: ACEITE,
    });

    expect(r.status).toBe(422);
    expect(r.body.erro.problemas[0].mensagem).toMatch(/Campo não permitido/);
    expect(r.body.erro.problemas[0].mensagem).toMatch(/email/);
    expect(await contarPacientes()).toBe(0);
  });

  test.each([
    ['telefone sem DDD', { telefone: '9999-8888' }, /DDD/],
    ['data inexistente', { dataNascimento: '1990-02-30' }, /não existe/],
    ['data no futuro', { dataNascimento: '2999-01-01' }, /futuro/],
    ['nome curto demais', { nome: 'A' }, /duas letras/],
  ])('%s → 422 em português', async (_rotulo, campo, mensagem) => {
    const r = await cadastrar(comoA, { nome: 'Maria', consentimento: ACEITE, ...campo });

    expect(r.status).toBe(422);
    expect(r.body.erro.problemas[0].mensagem).toMatch(mensagem);
    expect(r.body.erro.problemas[0].mensagem).not.toMatch(/Expected|Received|Invalid|String|Number/);
  });

  test('data de nascimento malformada gera uma única mensagem, e verdadeira', async () => {
    const r = await cadastrar(comoA, { nome: 'Maria', consentimento: ACEITE, dataNascimento: 'abc' });

    expect(r.status).toBe(422);
    // Antes da correção, "abc" também produzia "não pode estar no futuro",
    // porque "abc" > "2026-..." na comparação de texto.
    expect(r.body.erro.problemas).toHaveLength(1);
    expect(r.body.erro.problemas[0].mensagem).toMatch(/AAAA-MM-DD/);
  });

  test('o cadastro gera auditoria sem nome, telefone ou e-mail', async () => {
    await cadastrar(comoA, {
      nome: 'Maria da Silva',
      telefone: '88999998888',
      consentimento: ACEITE,
    });

    const { rows } = await consultar(
      "SELECT acao, detalhe FROM auditoria WHERE entidade = 'paciente'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].acao).toBe('paciente.cadastrado');

    const detalhe = JSON.stringify(rows[0].detalhe);
    expect(detalhe).not.toMatch(/Maria|88999998888|example\.com/);
  });
});

describe('isolamento entre pacientes', () => {
  beforeEach(async () => {
    await cadastrar(comoA, { nome: 'Ana Paciente', consentimento: ACEITE });
    await cadastrar(comoB, { nome: 'Bruno Paciente', consentimento: ACEITE });
  });

  test('o token de A só alcança o perfil de A', async () => {
    const r = await request(servidor).get('/pacientes/me').set(comoA);

    expect(r.status).toBe(200);
    expect(r.body.paciente).toMatchObject({ nome: 'Ana Paciente', email: A.email });
    expect(JSON.stringify(r.body)).not.toMatch(/Bruno|paciente\.b@/);
  });

  test('o token de B só alcança o perfil de B', async () => {
    const r = await request(servidor).get('/pacientes/me').set(comoB);

    expect(r.body.paciente).toMatchObject({ nome: 'Bruno Paciente', email: B.email });
    expect(JSON.stringify(r.body)).not.toMatch(/Ana|paciente\.a@/);
  });

  test('não existe rota que aceite o id de outro paciente', async () => {
    const { rows } = await consultar('SELECT id FROM paciente WHERE firebase_uid = $1', [B.uid]);
    const idDeB = rows[0].id;

    for (const caminho of [`/pacientes/${idDeB}`, `/pacientes?id=${idDeB}`]) {
      const r = await request(servidor).get(caminho).set(comoA);
      expect(JSON.stringify(r.body)).not.toMatch(/Bruno|paciente\.b@/);
    }
  });

  test('PATCH de A altera A e não toca em B', async () => {
    const r = await request(servidor)
      .patch('/pacientes/me')
      .set(comoA)
      .send({ nome: 'Ana Paula', telefone: '88988887777' });

    expect(r.status).toBe(200);
    expect(r.body.paciente).toMatchObject({ nome: 'Ana Paula', telefone: '88988887777' });

    const deB = await request(servidor).get('/pacientes/me').set(comoB);
    expect(deB.body.paciente.nome).toBe('Bruno Paciente');
    expect(deB.body.paciente.telefone).toBeNull();
  });
});

describe('PATCH /pacientes/me', () => {
  beforeEach(() => cadastrar(comoA, { nome: 'Ana Paciente', consentimento: ACEITE }));

  test.each([
    ['e-mail', { email: 'novo@example.com' }],
    ['consentimento', { consentimento: { aceito: true, versao: 'forjada' } }],
    ['uid', { firebaseUid: B.uid }],
  ])('tentar alterar %s → 422 em português', async (_rotulo, corpo) => {
    const r = await request(servidor).patch('/pacientes/me').set(comoA).send(corpo);

    expect(r.status).toBe(422);
    expect(r.body.erro.problemas[0].mensagem).toMatch(/Campo não permitido/);
  });

  test('corpo vazio → 422 pedindo ao menos um campo', async () => {
    const r = await request(servidor).patch('/pacientes/me').set(comoA).send({});

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('NADA_A_ATUALIZAR');
  });

  test('telefone pode ser removido com null', async () => {
    await request(servidor).patch('/pacientes/me').set(comoA).send({ telefone: '88988887777' });
    const r = await request(servidor).patch('/pacientes/me').set(comoA).send({ telefone: null });

    expect(r.status).toBe(200);
    expect(r.body.paciente.telefone).toBeNull();
  });

  test('a auditoria da atualização guarda só os nomes dos campos', async () => {
    await request(servidor).patch('/pacientes/me').set(comoA).send({ telefone: '88977776666' });

    const { rows } = await consultar(
      "SELECT detalhe FROM auditoria WHERE acao = 'paciente.atualizado'"
    );
    expect(rows[0].detalhe).toEqual({ campos: ['telefone'] });
    expect(JSON.stringify(rows[0].detalhe)).not.toMatch(/88977776666/);
  });
});

describe('adaptador de pacientes', () => {
  const { RepositorioDePacientesPg } = require('../../src/infra/db/RepositorioDePacientesPg');
  const repositorio = new RepositorioDePacientesPg();

  test('atualizar sem campo válido não monta SQL inválido', async () => {
    await cadastrar(comoA, { nome: 'Ana Paciente', consentimento: ACEITE });
    const ana = await repositorio.porFirebaseUid(A.uid);

    const depois = await repositorio.atualizar(ana.id, { campoInexistente: 'x' });

    expect(depois.nome).toBe('Ana Paciente');
  });

  test('atualizar paciente inexistente é 404, sem auditoria fantasma', async () => {
    await expect(repositorio.atualizar(999999, { nome: 'Ninguém' })).rejects.toMatchObject({
      codigo: 'NAO_ENCONTRADO',
    });

    const { rows } = await consultar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'paciente.atualizado'");
    expect(rows[0].n).toBe(0);
  });
});
