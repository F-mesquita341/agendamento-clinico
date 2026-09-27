'use strict';

/**
 * Limite de escritas por paciente (Etapa 10), contra o app inteiro.
 *
 * O que se prova aqui não é a biblioteca contar até N — é a forma como ela foi
 * ligada: a chave é o PACIENTE, e não o endereço; o orçamento é UM só, somado
 * entre as rotas; TODA rota de escrita passa por ele; leitura e webhook, não.
 *
 * Todos os pedidos destes testes saem do mesmo endereço, 127.0.0.1. É o que
 * torna o teste do paciente B significativo: se a chave fosse o IP, B seria
 * barrado junto com A.
 *
 * O limitador guarda a contagem na memória do app, então cada teste sobe um
 * app novo — senão o orçamento gasto num teste vazaria para o seguinte.
 */

const request = require('supertest');
const { iniciar, fechar } = require('../helpers/servidor');
const { limpar, semearPacientes } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { consultar, encerrar } = require('../../src/infra/db/pool');

const LIMITE = 3;

const comoA = { Authorization: `Bearer ${tokenDe('uid-paciente-a', 'paciente.a@example.com')}` };
const comoB = { Authorization: `Bearer ${tokenDe('uid-paciente-b', 'paciente.b@example.com')}` };
// Conta autenticada que ainda não fez o cadastro.
const comoSemCadastro = { Authorization: `Bearer ${tokenDe('uid-sem-cadastro', 'sem.cadastro@example.com')}` };

let servidor;

beforeEach(async () => {
  await limpar();
  await semearPacientes();
  servidor = await iniciar({ limiteDeEscritas: LIMITE });
});

afterEach(() => fechar(servidor));

afterAll(() => encerrar());

function renomear(cabecalhos, nome) {
  return request(servidor).patch('/pacientes/me').set(cabecalhos).send({ nome });
}

async function esgotar(cabecalhos) {
  for (let i = 1; i <= LIMITE; i += 1) {
    const r = await renomear(cabecalhos, `Ana Paciente ${i}`);
    expect(r.status).toBe(200);
  }
}

async function nomeDe(uid) {
  const { rows } = await consultar('SELECT nome FROM paciente WHERE firebase_uid = $1', [uid]);
  return rows[0].nome;
}

describe('limite de escritas por paciente', () => {
  test('as N primeiras escritas passam; a seguinte recebe 429 no envelope de sempre', async () => {
    await esgotar(comoA);

    const r = await renomear(comoA, 'Nome Que Não Pode Gravar');

    expect(r.status).toBe(429);
    expect(r.body).toEqual({
      erro: {
        codigo: 'MUITAS_REQUISICOES',
        mensagem: expect.stringMatching(/aguarde/i),
        acao: 'tentar_novamente',
      },
    });
    // Em segundos, dentro da janela de um minuto: é o que diz ao aplicativo
    // quando tentar de novo.
    expect(r.headers['retry-after']).toMatch(/^\d+$/);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  test('a escrita barrada não chega ao caso de uso', async () => {
    await esgotar(comoA);

    await renomear(comoA, 'Nome Que Não Pode Gravar');

    expect(await nomeDe('uid-paciente-a')).toBe(`Ana Paciente ${LIMITE}`);
  });

  test('o limite é do paciente, não do endereço: B segue livre enquanto A está barrado', async () => {
    // Celulares atrás do NAT da operadora dividem o mesmo IP. Um limite por
    // endereço puniria um desconhecido pelo outro.
    await esgotar(comoA);
    expect((await renomear(comoA, 'Ana de Novo')).status).toBe(429);

    const r = await renomear(comoB, 'Bruno Livre');

    expect(r.status).toBe(200);
  });

  test('o orçamento é um só, somado entre as rotas', async () => {
    // Uma instância por roteador daria a cada grupo de rotas um orçamento
    // próprio — três vezes o limite para quem alternasse entre eles.
    //
    // As três primeiras falham por outros motivos, e mesmo assim contam: se
    // só as bem-sucedidas contassem, bastaria mandar lixo para escrever à
    // vontade.
    const gastos = [
      await request(servidor).patch('/pacientes/me').set(comoA).send({ nome: 'Ana' }),
      await request(servidor).post('/dispositivos').set(comoA).send({}),
      await request(servidor).patch('/consultas/999999/cancelamento').set(comoA),
    ];
    expect(gastos.map((r) => r.status)).not.toContain(429);

    const r = await request(servidor).post('/consultas').set(comoA).send({});

    expect(r.status).toBe(429);
  });

  // Cada rota esgota o orçamento sozinha: se uma delas ficasse sem o
  // limitador, os LIMITE + 1 pedidos passariam todos.
  test.each([
    ['POST', '/pacientes'],
    ['PATCH', '/pacientes/me'],
    ['POST', '/consultas'],
    ['PATCH', '/consultas/1/cancelamento'],
    ['POST', '/consultas/1/pagamento'],
    ['POST', '/dispositivos'],
    ['DELETE', '/dispositivos/1'],
  ])('%s %s é limitada', async (metodo, caminho) => {
    const pedir = () => request(servidor)[metodo.toLowerCase()](caminho).set(comoA).send({});

    for (let i = 1; i <= LIMITE; i += 1) {
      expect((await pedir()).status).not.toBe(429);
    }

    expect((await pedir()).status).toBe(429);
  });

  // Recusado por não ter cadastro também conta, como qualquer pedido recusado.
  // Com o limitador DEPOIS de carregar o paciente, o 404 saía sem gastar
  // orçamento — era assim nas rotas de consulta.
  test.each([
    ['PATCH', '/pacientes/me'],
    ['POST', '/consultas'],
    ['PATCH', '/consultas/1/cancelamento'],
    ['POST', '/consultas/1/pagamento'],
    ['POST', '/dispositivos'],
    ['DELETE', '/dispositivos/1'],
  ])('%s %s: quem ainda não tem cadastro também gasta o orçamento', async (metodo, caminho) => {
    const pedir = () => request(servidor)[metodo.toLowerCase()](caminho).set(comoSemCadastro).send({});

    for (let i = 1; i <= LIMITE; i += 1) {
      expect((await pedir()).body.erro?.codigo).toBe('PERFIL_NAO_CADASTRADO');
    }

    expect((await pedir()).status).toBe(429);
  });

  test('quando a janela acaba, o paciente volta a escrever', async () => {
    // Janela curta, só aqui — em produção é de um minuto. Os pedidos são
    // cadastros sem corpo: a validação os recusa sem ir ao banco, e eles cabem
    // folgados na janela.
    const curto = await iniciar({ limiteDeEscritas: 2, janelaDeEscritasMs: 3000 });
    try {
      const cadastrar = () => request(curto).post('/pacientes').set(comoSemCadastro).send({});
      expect((await cadastrar()).status).not.toBe(429);
      expect((await cadastrar()).status).not.toBe(429);
      const barrado = await cadastrar();
      expect(barrado.status).toBe(429);

      // Espera o que o próprio Retry-After mandou esperar.
      await new Promise((pronto) => setTimeout(pronto, Number(barrado.headers['retry-after']) * 1000 + 200));

      expect((await cadastrar()).status).not.toBe(429);
    } finally {
      await fechar(curto);
    }
  });

  test('leitura não é limitada, nem gasta o orçamento', async () => {
    for (let i = 0; i < LIMITE * 3; i += 1) {
      expect((await request(servidor).get('/pacientes/me').set(comoA)).status).toBe(200);
      expect((await request(servidor).get('/consultas').set(comoA)).status).toBe(200);
    }

    // Depois de tantas leituras, o orçamento de escrita está inteiro.
    await esgotar(comoA);
  });

  test('leitura continua liberada para quem já está barrado', async () => {
    await esgotar(comoA);
    expect((await renomear(comoA, 'Ana de Novo')).status).toBe(429);

    const r = await request(servidor).get('/pacientes/me').set(comoA);

    expect(r.status).toBe(200);
  });

  test('o webhook não é limitado', async () => {
    // O Mercado Pago reenvia o que recebe 429, e a assinatura já protege a
    // rota. Formato IPN antigo: respondido com 200 sem tocar no banco.
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let i = 0; i < LIMITE * 3; i += 1) {
        const r = await request(servidor).post('/webhooks/mercadopago?topic=payment&id=1').send({});
        expect(r.status).toBe(200);
      }
    } finally {
      log.mockRestore();
    }
  });

  test('pedido sem sessão recebe 401, e não 429: o limite vem depois da autenticação', async () => {
    // Antes da autenticação não há paciente para contar. Quem não se
    // identificou é recusado pela autenticação, sempre com 401.
    for (let i = 0; i < LIMITE * 2; i += 1) {
      const r = await request(servidor).patch('/pacientes/me').send({ nome: 'Ninguém' });
      expect(r.status).toBe(401);
    }
  });
});
