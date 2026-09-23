'use strict';

/**
 * CORS com lista de origens (Etapa 10), contra o app inteiro.
 *
 * Quem aplica o CORS é o navegador: o servidor só diz, pelo cabeçalho
 * Access-Control-Allow-Origin, quem pode ler a resposta. Por isso o que se
 * confere aqui são os cabeçalhos — e também que pedido SEM origem, que é o do
 * aplicativo Android e o do webhook, segue atendido como sempre.
 *
 * Que produção não sobe com `*` é provado em tests/unit/config.test.js.
 */

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');

const PAGINA_DE_PROVA = 'http://localhost:4000';
const OUTRO_SITE = 'https://site-qualquer.example.com';

let servidor;

beforeAll(async () => {
  servidor = await iniciar({ origens: [PAGINA_DE_PROVA] });
});

afterAll(() => parar(servidor));

describe('CORS com lista de origens', () => {
  test('origem listada recebe a própria origem de volta', async () => {
    const r = await request(servidor).get('/saude').set('Origin', PAGINA_DE_PROVA);

    expect(r.headers['access-control-allow-origin']).toBe(PAGINA_DE_PROVA);
  });

  test('origem estranha não recebe o cabeçalho — o navegador bloqueia a leitura', async () => {
    const r = await request(servidor).get('/saude').set('Origin', OUTRO_SITE);

    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a resposta varia com a origem, para nenhum cache servir a de um site a outro', async () => {
    const r = await request(servidor).get('/saude').set('Origin', PAGINA_DE_PROVA);

    expect(r.headers.vary).toMatch(/\bOrigin\b/);
  });

  test('pedido sem origem — o do aplicativo Android e o do webhook — segue atendido', async () => {
    const r = await request(servidor).get('/saude');

    expect(r.status).toBe(200);
  });

  describe('pré-voo do registro de aparelho, que leva Authorization', () => {
    function preVoo(origem) {
      return request(servidor)
        .options('/dispositivos')
        .set('Origin', origem)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
    }

    test('da página de prova, é liberado', async () => {
      const r = await preVoo(PAGINA_DE_PROVA);

      expect(r.status).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(PAGINA_DE_PROVA);
      expect(r.headers['access-control-allow-headers']).toMatch(/authorization/i);
    });

    test('de outro site, não', async () => {
      const r = await preVoo(OUTRO_SITE);

      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
