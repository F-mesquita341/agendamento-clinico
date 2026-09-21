'use strict';

/**
 * Registro e revogação de aparelhos, contra o PostgreSQL real.
 *
 * O assunto central aqui não é CRUD: é a quem o aparelho pertence. Um telefone
 * passa de mão, e alguém sai do aplicativo para outra pessoa entrar. Se o
 * registro não reatribuir, o dono anterior continua recebendo ali o lembrete
 * das consultas dele — dado de saúde de terceiro numa tela bloqueada.
 */

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { limpar, semearPacientes } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { consultar } = require('../../src/infra/db/pool');

const A = { uid: 'uid-paciente-a', email: 'paciente.a@example.com' };
const B = { uid: 'uid-paciente-b', email: 'paciente.b@example.com' };
const comoA = { Authorization: `Bearer ${tokenDe(A.uid, A.email)}` };
const comoB = { Authorization: `Bearer ${tokenDe(B.uid, B.email)}` };

const TOKEN = 'fcm-token-do-aparelho-1';

let servidor;
let pacientes;

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(async () => {
  await limpar();
  pacientes = await semearPacientes();
});

afterAll(() => parar(servidor));

function registrar(cabecalhos, corpo = { token: TOKEN, plataforma: 'android' }) {
  return request(servidor).post('/dispositivos').set(cabecalhos).send(corpo);
}

async function donoDoToken(token) {
  const { rows } = await consultar('SELECT paciente_id FROM dispositivo WHERE token = $1', [token]);
  return rows.length ? Number(rows[0].paciente_id) : null;
}

async function quantosAparelhos() {
  const { rows } = await consultar('SELECT count(*)::int AS n FROM dispositivo');
  return rows[0].n;
}

async function auditoriaDeAparelhos() {
  const { rows } = await consultar(
    `SELECT acao, ator_id, entidade_id, detalhe FROM auditoria
      WHERE entidade = 'dispositivo' ORDER BY id`
  );
  return rows.map((l) => ({ ...l, ator_id: Number(l.ator_id), entidade_id: Number(l.entidade_id) }));
}

describe('POST /dispositivos', () => {
  test('registra o aparelho e devolve o id — que é por onde ele será revogado', async () => {
    const r = await registrar(comoA);

    expect(r.status).toBe(201);
    expect(r.body).toEqual({ dispositivo: { id: expect.any(Number) } });
    expect(await donoDoToken(TOKEN)).toBe(pacientes.a);
  });

  test('a resposta não devolve o token', async () => {
    // Quem enviou já o tem; repeti-lo só o faria existir em mais um lugar.
    const r = await registrar(comoA);

    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  test('registrar o mesmo aparelho de novo não duplica, e devolve o mesmo id', async () => {
    const primeiro = await registrar(comoA);
    const segundo = await registrar(comoA);

    expect(await quantosAparelhos()).toBe(1);
    expect(segundo.body.dispositivo.id).toBe(primeiro.body.dispositivo.id);
  });

  test('aparelho que troca de conta é REATRIBUÍDO, não duplicado', async () => {
    await registrar(comoA);

    const r = await registrar(comoB);

    expect(r.status).toBe(201);
    expect(await quantosAparelhos()).toBe(1);
    expect(await donoDoToken(TOKEN)).toBe(pacientes.b);
  });

  test.each([
    ['sem token', { plataforma: 'android' }],
    ['token vazio', { token: '   ', plataforma: 'android' }],
    ['sem plataforma', { token: TOKEN }],
    ['plataforma desconhecida', { token: TOKEN, plataforma: 'symbian' }],
    ['campo a mais', { token: TOKEN, plataforma: 'android', pacienteId: 1 }],
  ])('%s → 422', async (_rotulo, corpo) => {
    const r = await registrar(comoA, corpo);

    expect(r.status).toBe(422);
    expect(await quantosAparelhos()).toBe(0);
  });

  test('plataforma desconhecida explica em português, e não com a mensagem do zod', async () => {
    // A mensagem padrão do zod para valor fora da lista é em inglês, e o
    // aplicativo a mostraria ao paciente.
    const r = await registrar(comoA, { token: TOKEN, plataforma: 'symbian' });

    expect(JSON.stringify(r.body)).toMatch(/Informe a plataforma do aparelho/);
    expect(JSON.stringify(r.body)).not.toMatch(/Invalid enum value/);
  });

  test('sem autenticação → 401', async () => {
    const r = await request(servidor).post('/dispositivos').send({ token: TOKEN, plataforma: 'android' });

    expect(r.status).toBe(401);
  });

  test('a resposta não fica em cache de proxy nem do navegador', async () => {
    const r = await registrar(comoA);

    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('DELETE /dispositivos/:id', () => {
  test('o dono revoga o próprio aparelho → 204', async () => {
    const { body } = await registrar(comoA);

    const r = await request(servidor).delete(`/dispositivos/${body.dispositivo.id}`).set(comoA);

    expect(r.status).toBe(204);
    expect(await quantosAparelhos()).toBe(0);
  });

  test('revogar aparelho alheio → 404, e o aparelho continua lá', async () => {
    // 404 e não 403: com 403 dava para descobrir quais ids existem mandando
    // tentativas. Assim, não existe e não é seu são indistinguíveis de fora.
    const { body } = await registrar(comoA);

    const r = await request(servidor).delete(`/dispositivos/${body.dispositivo.id}`).set(comoB);

    expect(r.status).toBe(404);
    expect(await donoDoToken(TOKEN)).toBe(pacientes.a);
  });

  test('o 404 diz "Aparelho não encontrado." uma vez só', async () => {
    const r = await request(servidor).delete('/dispositivos/999999').set(comoA);

    expect(r.status).toBe(404);
    expect(r.body.erro.mensagem).toBe('Aparelho não encontrado.');
  });

  test('id que não é número → 422, e não 500', async () => {
    const r = await request(servidor).delete(`/dispositivos/${TOKEN}`).set(comoA);

    expect(r.status).toBe(422);
  });

  test('sem autenticação → 401', async () => {
    const { body } = await registrar(comoA);

    const r = await request(servidor).delete(`/dispositivos/${body.dispositivo.id}`);

    expect(r.status).toBe(401);
    expect(await quantosAparelhos()).toBe(1);
  });
});

describe('auditoria', () => {
  test('registro, reatribuição e revogação ficam registrados — sem o token', async () => {
    const { body } = await registrar(comoA);
    const id = body.dispositivo.id;
    await registrar(comoB);
    await request(servidor).delete(`/dispositivos/${id}`).set(comoB);

    const linhas = await auditoriaDeAparelhos();
    expect(linhas).toEqual([
      { acao: 'dispositivo.registrado', ator_id: pacientes.a, entidade_id: id, detalhe: { plataforma: 'android' } },
      {
        acao: 'dispositivo.reatribuido',
        ator_id: pacientes.b,
        entidade_id: id,
        detalhe: { donoAnterior: pacientes.a, plataforma: 'android' },
      },
      { acao: 'dispositivo.revogado', ator_id: pacientes.b, entidade_id: id, detalhe: null },
    ]);
    expect(JSON.stringify(linhas)).not.toContain(TOKEN);
  });

  test('registrar de novo o próprio aparelho não gera linha — o aplicativo faz isso a cada abertura', async () => {
    await registrar(comoA);
    await registrar(comoA);
    await registrar(comoA);

    expect(await auditoriaDeAparelhos()).toHaveLength(1);
  });

  test('revogação recusada não gera linha', async () => {
    const { body } = await registrar(comoA);

    await request(servidor).delete(`/dispositivos/${body.dispositivo.id}`).set(comoB);

    expect((await auditoriaDeAparelhos()).map((l) => l.acao)).toEqual(['dispositivo.registrado']);
  });
});
