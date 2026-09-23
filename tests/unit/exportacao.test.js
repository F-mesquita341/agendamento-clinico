'use strict';

/**
 * A parte pura da exportação para a pesquisa: pseudônimo, colunas, CSV e a
 * guarda da pasta de saída. A exportação sobre o banco está em
 * tests/integration/exportacao.test.js.
 */

const path = require('node:path');
const os = require('node:os');
const {
  COLUNAS_DE_CONSULTAS,
  COLUNAS_DE_EVENTOS,
  SegredoInadequado,
  criarPseudonimizador,
  linhaDeConsulta,
  linhaDeEvento,
  paraCsv,
  estaDentro,
  haColisao,
} = require('../../scripts/exportacao/pseudonimizar');

const SEGREDO = 'a'.repeat(64);
const OUTRO_SEGREDO = 'b'.repeat(64);

describe('pseudônimo', () => {
  const p = criarPseudonimizador(SEGREDO);

  test('tem prefixo e 16 dígitos hexadecimais', () => {
    expect(p.paciente(1)).toMatch(/^P-[0-9a-f]{16}$/);
    expect(p.consulta(1)).toMatch(/^C-[0-9a-f]{16}$/);
  });

  test('é estável: o mesmo id dá o mesmo pseudônimo, venha como número ou texto', () => {
    // O driver entrega BIGINT como texto; o mesmo paciente não pode virar dois.
    expect(p.paciente(42)).toBe(p.paciente('42'));
    expect(criarPseudonimizador(SEGREDO).paciente(42)).toBe(p.paciente(42));
  });

  test('ids diferentes dão pseudônimos diferentes', () => {
    expect(p.paciente(1)).not.toBe(p.paciente(2));
  });

  test('outro segredo dá outro pseudônimo — sem o segredo, não se refaz a ligação', () => {
    expect(criarPseudonimizador(OUTRO_SEGREDO).paciente(42)).not.toBe(p.paciente(42));
  });

  test('paciente e consulta de mesmo id não têm o mesmo código', () => {
    expect(p.paciente(7).slice(2)).not.toBe(p.consulta(7).slice(2));
  });

  test('não contém o id', () => {
    // Um prefixo com o próprio id, ou um hash sem segredo, seria desfeito
    // calculando o de 1, 2, 3...
    expect(p.paciente(123456)).not.toMatch(/123456/);
  });

  test('id ausente vira campo vazio', () => {
    expect(p.paciente(null)).toBe('');
    expect(p.consulta(undefined)).toBe('');
  });

  test.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['curto demais', 'x'.repeat(31)],
  ])('segredo %s é recusado', (_rotulo, segredo) => {
    expect(() => criarPseudonimizador(segredo)).toThrow(SegredoInadequado);
  });

  test('a recusa não repete o segredo', () => {
    const curto = 'segredo-curto-que-nao-aparece';
    expect(() => criarPseudonimizador(curto)).toThrow(expect.objectContaining({
      message: expect.not.stringContaining(curto),
    }));
  });
});

describe('colunas', () => {
  const p = criarPseudonimizador(SEGREDO);

  // Uma linha como a que o banco devolveria se a consulta fosse descuidada:
  // com tudo o que NÃO pode sair.
  const DADOS_PESSOAIS = {
    nome: 'Ana Paciente da Silva',
    email: 'ana.paciente@example.com',
    telefone: '88999998888',
    data_nascimento: '1990-05-17',
    firebase_uid: 'uid-firebase-da-ana',
    token: 'token-fcm-do-telefone-da-ana',
    profissional: 'José Antônio Ferreira',
    especialidade: 'Cardiologia',
    valor_centavos: 25000,
    pagamento_externo_id: 'MP-PAGAMENTO-987654',
    referencia_externa: '3f1c2b7e-referencia-interna',
    detalhe: { plataforma: 'android', aparelhos: 1 },
  };

  test('consultas.csv só tem as colunas da lista, nesta ordem', () => {
    const csv = paraCsv(COLUNAS_DE_CONSULTAS, [
      linhaDeConsulta({ ...DADOS_PESSOAIS, consulta_id: '5', paciente_id: '3', status: 'confirmada', paga: true }, p),
    ]);

    expect(csv.split('\n')[0]).toBe(
      'consulta,paciente,status,motivo_cancelamento,inicio,criada_em,paga,lembrete_enviado_em'
    );
  });

  test.each([
    ['consultas.csv', COLUNAS_DE_CONSULTAS, linhaDeConsulta],
    ['eventos.csv', COLUNAS_DE_EVENTOS, linhaDeEvento],
  ])('%s não leva nenhum dado pessoal, mesmo que a linha do banco traga', (_arquivo, colunas, converter) => {
    const linha = {
      ...DADOS_PESSOAIS,
      consulta_id: '5',
      paciente_id: '3',
      status: 'confirmada',
      ator_tipo: 'paciente',
      acao: 'consulta.criada',
      criado_em: new Date('2026-09-23T12:00:00Z'),
    };

    const csv = paraCsv(colunas, [converter(linha, p)]);

    for (const [campo, valor] of Object.entries(DADOS_PESSOAIS)) {
      const texto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
      expect({ campo, presente: csv.includes(texto) }).toEqual({ campo, presente: false });
    }
    // Nem os ids internos, que ligariam a linha de volta ao banco.
    expect(csv).not.toMatch(/(^|,)(3|5)(,|$)/m);
  });

  test('a linha de consulta converte instantes, pagamento e motivo', () => {
    const linha = linhaDeConsulta(
      {
        consulta_id: '5',
        paciente_id: '3',
        status: 'cancelada',
        motivo_cancelamento: 'reserva_expirada',
        inicio: new Date('2026-09-24T11:30:00Z'),
        criado_em: new Date('2026-09-23T09:00:00Z'),
        paga: false,
        lembrete_enviado_em: null,
      },
      p
    );

    expect(linha).toEqual({
      consulta: p.consulta('5'),
      paciente: p.paciente('3'),
      status: 'cancelada',
      motivo_cancelamento: 'reserva_expirada',
      inicio: '2026-09-24T11:30:00.000Z',
      criada_em: '2026-09-23T09:00:00.000Z',
      paga: 0,
      lembrete_enviado_em: '',
    });
  });

  test('a linha de evento sem consulta nem paciente deixa os campos vazios', () => {
    const linha = linhaDeEvento(
      { paciente_id: null, consulta_id: null, ator_tipo: 'sistema', acao: 'x', criado_em: new Date(0) },
      p
    );

    expect(linha).toMatchObject({ paciente: '', consulta: '', ator: 'sistema' });
  });
});

describe('CSV', () => {
  test('escapa vírgula, aspas e quebra de linha', () => {
    const csv = paraCsv(['a', 'b', 'c'], [{ a: 'x,y', b: 'diz "oi"', c: 'linha\nnova' }]);

    expect(csv).toBe('a,b,c\n"x,y","diz ""oi""","linha\nnova"\n');
  });

  test('só grava as colunas pedidas, mesmo que a linha traga outras', () => {
    const csv = paraCsv(['a'], [{ a: 1, nome: 'Ana' }]);

    expect(csv).toBe('a\n1\n');
  });

  test('sem linhas, sai só o cabeçalho', () => {
    expect(paraCsv(['a', 'b'], [])).toBe('a,b\n');
  });
});

describe('pasta de saída', () => {
  const raiz = path.join(os.tmpdir(), 'repositorio');

  test.each([
    ['a própria raiz', true, raiz],
    ['uma subpasta', true, path.join(raiz, 'docs', 'dados')],
    ['uma pasta cujo nome começa com ".."', true, path.join(raiz, '..dados')],
    ['a pasta acima', false, path.dirname(raiz)],
    ['uma vizinha com o mesmo começo de nome', false, `${raiz}-dados`],
    ['outro lugar', false, path.join(os.tmpdir(), 'pesquisa')],
  ])('%s → dentro: %s', (_rotulo, esperado, pasta) => {
    expect(estaDentro(pasta, raiz)).toBe(esperado);
  });

  (process.platform === 'win32' ? test : test.skip)(
    'no Windows, maiúsculas e minúsculas não disfarçam a raiz',
    () => {
      expect(estaDentro(path.join(raiz.toUpperCase(), 'dados'), raiz)).toBe(true);
    }
  );
});

describe('colisão de pseudônimos', () => {
  test('sem colisão, com ids repetidos e ausentes', () => {
    const p = criarPseudonimizador(SEGREDO);

    expect(haColisao(['1', 1, '2', null, undefined], p.paciente)).toBe(false);
  });

  test('detecta dois ids com o mesmo pseudônimo', () => {
    expect(haColisao(['1', '2'], () => 'P-igual')).toBe(true);
  });
});
