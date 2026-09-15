'use strict';

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { semear } = require('../helpers/semente');

let servidor;
let dados;

beforeAll(async () => {
  servidor = await iniciar();
  dados = await semear();
});

afterAll(() => parar(servidor));

describe('GET /especialidades', () => {
  test('lista em ordem alfabética', async () => {
    const r = await request(servidor).get('/especialidades');

    expect(r.status).toBe(200);
    expect(r.body.especialidades.map((e) => e.nome)).toEqual([
      'Cardiologia',
      'Pediatria',
    ]);
  });

  test('permite cache, por ser lista de baixa rotatividade', async () => {
    const r = await request(servidor).get('/especialidades');

    expect(r.headers['cache-control']).toMatch(/max-age/);
  });
});

describe('GET /profissionais', () => {
  test('lista só quem está ativo', async () => {
    const r = await request(servidor).get('/profissionais');

    expect(r.status).toBe(200);
    expect(r.body.profissionais).toHaveLength(2);
    expect(r.body.profissionais.map((p) => p.nome)).not.toContain(
      'Marcos Aposentado'
    );
  });

  test('traz o valor em centavos e já formatado', async () => {
    const r = await request(servidor).get('/profissionais');
    const jose = r.body.profissionais.find((p) => p.nome.startsWith('José'));

    expect(jose.valorCentavos).toBe(25000);
    expect(jose.valorFormatado).toBe('R$ 250,00');
    expect(jose.especialidade.nome).toBe('Cardiologia');
  });

  test('filtra por especialidade', async () => {
    const r = await request(servidor).get(
      `/profissionais?especialidade=${dados.especialidades.pediatria}`
    );

    expect(r.body.profissionais).toHaveLength(1);
    expect(r.body.profissionais[0].nome).toBe('Inês Cardoso Lima');
  });

  test('busca por nome ignora acento e caixa', async () => {
    for (const termo of ['jose', 'JOSÉ', 'AntOnio', 'ferreira']) {
      const r = await request(servidor).get(`/profissionais?q=${encodeURIComponent(termo)}`);

      expect(r.body.profissionais.map((p) => p.nome)).toEqual([
        'José Antônio Ferreira',
      ]);
    }
  });

  test('busca sem resultado devolve lista vazia, não erro', async () => {
    const r = await request(servidor).get('/profissionais?q=zzzzzz');

    expect(r.status).toBe(200);
    expect(r.body.profissionais).toEqual([]);
    expect(r.body.paginacao.total).toBe(0);
  });

  test('pagina e informa o total do conjunto completo', async () => {
    const r = await request(servidor).get('/profissionais?limite=1&pagina=1');

    expect(r.body.profissionais).toHaveLength(1);
    expect(r.body.paginacao).toMatchObject({
      pagina: 1,
      limite: 1,
      total: 2,
      paginas: 2,
    });
  });

  test('filtro malformado é 422 com o campo apontado', async () => {
    const r = await request(servidor).get('/profissionais?especialidade=abc');

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('DADOS_INVALIDOS');
    expect(r.body.erro.problemas[0].campo).toBe('especialidade');
  });

  test('busca com uma única letra é recusada', async () => {
    const r = await request(servidor).get('/profissionais?q=a');

    expect(r.status).toBe(422);
    expect(r.body.erro.problemas[0].mensagem).toMatch(/duas letras/i);
  });
});

describe('GET /profissionais/:id', () => {
  test('devolve o profissional pedido', async () => {
    const r = await request(servidor).get(`/profissionais/${dados.profissionais.ines}`);

    expect(r.status).toBe(200);
    expect(r.body.profissional.nome).toBe('Inês Cardoso Lima');
  });

  test('profissional inativo responde 404', async () => {
    const r = await request(servidor).get(`/profissionais/${dados.profissionais.inativo}`);

    expect(r.status).toBe(404);
    expect(r.body.erro.codigo).toBe('NAO_ENCONTRADO');
  });

  test('id inexistente responde 404', async () => {
    const r = await request(servidor).get('/profissionais/999999');

    expect(r.status).toBe(404);
  });
});

describe('GET /profissionais/:id/horarios', () => {
  test('cada horário traz a versão, sem a qual não há lock otimista', async () => {
    const r = await request(servidor).get(
      `/profissionais/${dados.profissionais.jose}/horarios`
    );

    expect(r.status).toBe(200);
    for (const h of r.body.horarios) {
      expect(h).toHaveProperty('versao');
      expect(typeof h.versao).toBe('number');
    }

    const comVersao7 = r.body.horarios.find((h) => h.id === dados.horarios.comVersao7);
    expect(comVersao7.versao).toBe(7);
  });

  test('omite horários no passado e já reservados', async () => {
    const r = await request(servidor).get(
      `/profissionais/${dados.profissionais.jose}/horarios`
    );

    const ids = r.body.horarios.map((h) => h.id);
    expect(ids).not.toContain(dados.horarios.passado);
    expect(ids).not.toContain(dados.horarios.reservado);
    expect(ids).toContain(dados.horarios.amanha);
  });

  test('traz duração e datas em ISO 8601', async () => {
    const r = await request(servidor).get(
      `/profissionais/${dados.profissionais.jose}/horarios`
    );
    const primeiro = r.body.horarios[0];

    expect(primeiro.duracaoMinutos).toBe(30);
    expect(primeiro.inicio).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('respeita a janela pedida', async () => {
    const amanha = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();
    const r = await request(servidor).get(
      `/profissionais/${dados.profissionais.jose}/horarios?ate=${encodeURIComponent(amanha)}`
    );

    // Só o horário de amanhã cabe na janela; o de depois de amanhã fica fora.
    expect(r.body.horarios.map((h) => h.id)).toEqual([dados.horarios.amanha]);
  });

  test('horários de profissional inexistente respondem 404', async () => {
    const r = await request(servidor).get('/profissionais/999999/horarios');

    expect(r.status).toBe(404);
  });
});

describe('mensagens de erro', () => {
  test('são escritas em português, para o usuário final', async () => {
    const casos = [
      '/profissionais?especialidade=abc',
      '/profissionais?pagina=zero',
      '/profissionais/xyz',
      '/profissionais/1/horarios?de=nao-e-data',
    ];

    for (const caminho of casos) {
      const r = await request(servidor).get(caminho);

      expect(r.status).toBe(422);
      for (const problema of r.body.erro.problemas) {
        // Nenhum vazamento das mensagens padrão do Zod, que são em inglês.
        expect(problema.mensagem).not.toMatch(/Expected|Received|Invalid|String|Number/);
        expect(problema.mensagem).toMatch(/[áéíóúâêôãõç]|precisa|Busque|limite/i);
      }
    }
  });
});
