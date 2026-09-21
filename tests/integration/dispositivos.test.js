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
const { limpar } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { consultar } = require('../../src/infra/db/pool');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../../src/domain/Paciente');

const A = { uid: 'uid-paciente-a', email: 'paciente.a@example.com' };
const B = { uid: 'uid-paciente-b', email: 'paciente.b@example.com' };
const comoA = { Authorization: `Bearer ${tokenDe(A.uid, A.email)}` };
const comoB = { Authorization: `Bearer ${tokenDe(B.uid, B.email)}` };

const TOKEN = 'fcm-token-do-aparelho-1';

let servidor;

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(async () => {
  await limpar();
  for (const [cabecalhos, nome] of [
    [comoA, 'Paciente A'],
    [comoB, 'Paciente B'],
  ]) {
    await request(servidor)
      .post('/pacientes')
      .set(cabecalhos)
      .send({ nome, consentimento: { aceito: true, versao: VERSAO_TERMO_CONSENTIMENTO } });
  }
});

afterAll(() => parar(servidor));

function registrar(cabecalhos, corpo = { token: TOKEN, plataforma: 'android' }) {
  return request(servidor).post('/dispositivos').set(cabecalhos).send(corpo);
}

async function donoDoToken(token) {
  const { rows } = await consultar(
    `SELECT p.nome FROM dispositivo d JOIN paciente p ON p.id = d.paciente_id WHERE d.token = $1`,
    [token]
  );
  return rows[0]?.nome ?? null;
}

async function quantosAparelhos() {
  const { rows } = await consultar('SELECT count(*)::int AS n FROM dispositivo');
  return rows[0].n;
}

describe('POST /dispositivos', () => {
  test('registra o aparelho da conta autenticada → 201', async () => {
    const r = await registrar(comoA);

    expect(r.status).toBe(201);
    expect(await donoDoToken(TOKEN)).toBe('Paciente A');
  });

  test('a resposta não devolve o token', async () => {
    // Quem enviou já o tem; repeti-lo só o faria existir em mais um lugar.
    const r = await registrar(comoA);

    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  test('registrar o mesmo aparelho de novo não duplica', async () => {
    await registrar(comoA);
    await registrar(comoA);

    expect(await quantosAparelhos()).toBe(1);
  });

  test('aparelho que troca de conta é REATRIBUÍDO, não duplicado', async () => {
    await registrar(comoA);

    const r = await registrar(comoB);

    expect(r.status).toBe(201);
    expect(await quantosAparelhos()).toBe(1);
    expect(await donoDoToken(TOKEN)).toBe('Paciente B');
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

  test('sem autenticação → 401', async () => {
    const r = await request(servidor).post('/dispositivos').send({ token: TOKEN, plataforma: 'android' });

    expect(r.status).toBe(401);
  });
});

describe('DELETE /dispositivos/:token', () => {
  test('o dono revoga o próprio aparelho → 204', async () => {
    await registrar(comoA);

    const r = await request(servidor).delete(`/dispositivos/${TOKEN}`).set(comoA);

    expect(r.status).toBe(204);
    expect(await quantosAparelhos()).toBe(0);
  });

  test('revogar aparelho alheio → 404, e o aparelho continua lá', async () => {
    // 404 e não 403: com 403 dava para descobrir se um token existe mandando
    // tentativas. Assim, não existe e não é seu são indistinguíveis de fora.
    await registrar(comoA);

    const r = await request(servidor).delete(`/dispositivos/${TOKEN}`).set(comoB);

    expect(r.status).toBe(404);
    expect(await donoDoToken(TOKEN)).toBe('Paciente A');
  });

  test('revogar token inexistente → 404', async () => {
    const r = await request(servidor).delete('/dispositivos/nao-existe').set(comoA);

    expect(r.status).toBe(404);
  });

  test('sem autenticação → 401', async () => {
    await registrar(comoA);

    const r = await request(servidor).delete(`/dispositivos/${TOKEN}`);

    expect(r.status).toBe(401);
    expect(await quantosAparelhos()).toBe(1);
  });
});
