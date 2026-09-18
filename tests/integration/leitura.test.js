'use strict';

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { semear } = require('../helpers/semente');
const { consultar } = require('../../src/infra/db/pool');

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

describe('curingas do LIKE na busca', () => {
  test('"%%" não casa com todo mundo — é tratado como texto', async () => {
    const r = await request(servidor).get('/profissionais?q=%25%25');

    expect(r.status).toBe(200);
    expect(r.body.profissionais).toEqual([]);
    expect(r.body.paginacao.total).toBe(0);
  });

  test('"__" não casa com qualquer nome — é tratado como texto', async () => {
    const r = await request(servidor).get('/profissionais?q=__');

    expect(r.body.profissionais).toEqual([]);
    expect(r.body.paginacao.total).toBe(0);
  });

  test('a busca legítima continua funcionando depois do escape', async () => {
    const r = await request(servidor).get('/profissionais?q=Ferreira');

    expect(r.body.profissionais).toHaveLength(1);
  });
});

describe('paginação', () => {
  test('página além do fim informa o total real, não zero', async () => {
    const r = await request(servidor).get('/profissionais?limite=10&pagina=5');

    expect(r.status).toBe(200);
    expect(r.body.profissionais).toEqual([]);
    expect(r.body.paginacao.total).toBe(2);
  });

  test.each([
    ['página astronômica', '/profissionais?pagina=1e21'],
    ['página acima do limite de bigint', '/profissionais?pagina=500000000000000000'],
    ['especialidade astronômica', '/profissionais?especialidade=1e23'],
    ['id astronômico na rota', '/profissionais/99999999999999999999999'],
  ])('%s é recusada pela validação, sem virar erro interno', async (_rotulo, caminho) => {
    // Number.isInteger(1e21) é verdadeiro: sem teto, esses valores atravessavam
    // a validação e o PostgreSQL é que recusava — 500 numa rota pública, aberta
    // a qualquer pessoa, enterrando falhas de verdade no log.
    const r = await request(servidor).get(caminho);

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('DADOS_INVALIDOS');
  });
});

describe('estabilidade da paginação', () => {
  let homonimas = [];

  // Ids explícitos, gravados em ordem física INVERSA à do id: o de id maior
  // entra primeiro. Numa tabela pequena o PostgreSQL devolve as linhas na ordem
  // física, e com ids em sequência essa ordem coincidiria com a do id — o teste
  // passaria mesmo sem o desempate. Foi o que aconteceu na primeira versão dele.
  const MAIOR = 900_002;
  const MENOR = 900_001;

  beforeAll(async () => {
    for (const [id, crm] of [
      [MAIOR, 'CRM-CE 90002'],
      [MENOR, 'CRM-CE 90001'],
    ]) {
      await consultar(
        `INSERT INTO profissional
           (id, clinica_id, especialidade_id, nome, registro_conselho,
            valor_consulta_centavos, ativo)
         VALUES ($1, $2, $3, 'Zulmira Homônima', $4, 10000, TRUE)`,
        [id, dados.clinicaId, dados.especialidades.cardiologia, crm]
      );
    }
    homonimas = [MENOR, MAIOR];
  });

  afterAll(() => consultar('DELETE FROM profissional WHERE id = ANY($1)', [homonimas]));

  test('homônimas saem em ordem de id, sem se repetir entre páginas', async () => {
    // Com ORDER BY p.nome sozinho, o desempate entre nomes iguais é arbitrário:
    // a mesma pessoa podia aparecer nas duas páginas enquanto a outra sumia.
    // O contrato é nome e, no empate, id.
    const primeira = await request(servidor).get('/profissionais?q=Zulmira&limite=1&pagina=1');
    const segunda = await request(servidor).get('/profissionais?q=Zulmira&limite=1&pagina=2');

    expect(primeira.body.paginacao.total).toBe(2);
    expect(primeira.body.profissionais[0].id).toBe(MENOR);
    expect(segunda.body.profissionais[0].id).toBe(MAIOR);
  });
});

describe('janela de horários', () => {
  test('janela invertida é recusada, em vez de fingir grade vazia', async () => {
    const r = await request(servidor).get(
      `/profissionais/${dados.profissionais.jose}/horarios?ate=2020-01-01`
    );

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('JANELA_INVALIDA');
  });

  test('data sem hora é lida no fuso da clínica, não em UTC', async () => {
    // Meia-noite em Fortaleza é 03:00 UTC. Lida como UTC, a janela começaria
    // às 21h do dia anterior e traria horários do dia errado.
    const daquiATresDias = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const r = await request(servidor).get(
      `/profissionais/${dados.profissionais.jose}/horarios?de=${daquiATresDias}`
    );

    expect(r.status).toBe(200);
    expect(r.body.periodo.de).toBe(`${daquiATresDias}T03:00:00.000Z`);
  });
});

describe('termo de busca repetido na query', () => {
  test('?q=a&q=b é recusado em português, não com a mensagem do Zod', async () => {
    const r = await request(servidor).get('/profissionais?q=ana&q=jose');

    expect(r.status).toBe(422);
    expect(r.body.erro.problemas[0].campo).toBe('q');
    expect(r.body.erro.problemas[0].mensagem).toBe('Informe um único termo de busca.');
  });
});

describe('erros do analisador de corpo', () => {
  test('corpo acima do limite é 413, não 500', async () => {
    const gigante = { texto: 'x'.repeat(200 * 1024) };

    const r = await request(servidor)
      .post('/profissionais')
      .set('Content-Type', 'application/json')
      .send(gigante);

    expect(r.status).toBe(413);
    expect(r.body.erro.codigo).toBe('CORPO_GRANDE_DEMAIS');
  });

  test('JSON malformado é 400, não 500', async () => {
    const r = await request(servidor)
      .post('/profissionais')
      .set('Content-Type', 'application/json')
      .send('{"isto": nao e json}');

    expect(r.status).toBe(400);
    expect(r.body.erro.codigo).toBe('JSON_INVALIDO');
  });

  test('nenhum problema de envio do cliente aparece como erro interno', async () => {
    const casos = [
      ['{"a":', 'application/json'],
      ['x'.repeat(200 * 1024), 'application/json'],
    ];

    for (const [corpo, tipo] of casos) {
      const r = await request(servidor)
        .post('/rota-qualquer')
        .set('Content-Type', tipo)
        .send(corpo);

      expect(r.status).toBeLessThan(500);
      expect(r.body.erro.codigo).not.toBe('ERRO_INTERNO');
    }
  });
});
