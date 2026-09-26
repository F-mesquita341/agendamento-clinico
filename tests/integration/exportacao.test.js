'use strict';

/**
 * Exportação para a pesquisa, sobre o banco de teste (Etapa 10).
 *
 * O cenário é montado pela API, como aconteceria de verdade, e carrega de
 * propósito tudo o que não pode sair: nome, e-mail, telefone, uid do Firebase,
 * token do aparelho, profissional, especialidade e os identificadores do
 * Mercado Pago. O teste procura cada um deles nos arquivos gerados.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { iniciar, parar } = require('../helpers/servidor');
const { semear, semearPacientes } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { consultar } = require('../../src/infra/db/pool');
const { exportar, Recusa } = require('../../scripts/exportar-pesquisa');
const {
  SegredoInadequado,
  criarPseudonimizador,
} = require('../../scripts/exportacao/pseudonimizar');

const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres';
const RAIZ = path.resolve(__dirname, '..', '..');

const comoA = { Authorization: `Bearer ${tokenDe('uid-paciente-a', 'paciente.a@example.com')}` };
const comoB = { Authorization: `Bearer ${tokenDe('uid-paciente-b', 'paciente.b@example.com')}` };

const TELEFONE_DA_ANA = '88999998888';
const TOKEN_DO_APARELHO = 'token-fcm-do-telefone-da-ana';
const PAGAMENTO_EXTERNO = 'MP-EXTERNO-424242';
const REFERENCIA = 'referencia-interna-do-checkout';

// Tudo o que o cenário grava e que não pode aparecer na exportação.
const PROIBIDOS = [
  'Ana Paciente',
  'Bruno Paciente',
  'paciente.a@example.com',
  'paciente.b@example.com',
  'uid-paciente-a',
  'uid-paciente-b',
  TELEFONE_DA_ANA,
  TOKEN_DO_APARELHO,
  'José Antônio',
  'Cardiologia',
  'CRM-CE',
  PAGAMENTO_EXTERNO,
  REFERENCIA,
];

let servidor;
let pasta;
let pacientes;
let consultaDaAna;
let consultaDoBruno;

function lerCsv(arquivo) {
  const [cabecalho, ...linhas] = fs.readFileSync(arquivo, 'utf8').trimEnd().split('\n');
  const colunas = cabecalho.split(',');
  return {
    colunas,
    linhas: linhas.map((l) => Object.fromEntries(l.split(',').map((v, i) => [colunas[i], v]))),
  };
}

beforeAll(async () => {
  servidor = await iniciar();
  const semente = await semear();
  pacientes = await semearPacientes();

  await request(servidor).patch('/pacientes/me').set(comoA).send({ telefone: TELEFONE_DA_ANA }).expect(200);
  await request(servidor)
    .post('/dispositivos')
    .set(comoA)
    .send({ token: TOKEN_DO_APARELHO, plataforma: 'android' })
    .expect(201);

  const a = await request(servidor)
    .post('/consultas')
    .set(comoA)
    .send({ horarioId: semente.horarios.amanha, versao: 0 })
    .expect(201);
  consultaDaAna = a.body.consulta.id;
  await request(servidor).patch(`/consultas/${consultaDaAna}/cancelamento`).set(comoA).expect(200);

  const b = await request(servidor)
    .post('/consultas')
    .set(comoB)
    .send({ horarioId: semente.horarios.comVersao7, versao: 7 })
    .expect(201);
  consultaDoBruno = b.body.consulta.id;

  // Pagamento aprovado e o evento dele, como o webhook os deixaria.
  const { rows } = await consultar(
    `INSERT INTO pagamento (consulta_id, status, valor_centavos, pagamento_externo_id, referencia_externa)
     VALUES ($1, 'aprovado', 25000, $2, $3) RETURNING id`,
    [consultaDoBruno, PAGAMENTO_EXTERNO, REFERENCIA]
  );
  await consultar(
    `INSERT INTO auditoria (ator_tipo, acao, entidade, entidade_id, detalhe)
     VALUES ('webhook', 'pagamento.aprovado', 'pagamento', $1, $2)`,
    [rows[0].id, { pagamentoExterno: PAGAMENTO_EXTERNO }]
  );
});

beforeEach(() => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'exportacao-'));
});

afterEach(() => {
  fs.rmSync(pasta, { recursive: true, force: true });
});

afterAll(() => parar(servidor));

describe('exportação para a pesquisa', () => {
  const p = criarPseudonimizador(SEGREDO);

  test('grava os dois arquivos, numa pasta que ainda não existia', async () => {
    const saida = path.join(pasta, 'rodada-1');

    const r = await exportar({ saida, segredo: SEGREDO });

    expect(r).toMatchObject({ consultas: 2 });
    expect(fs.readdirSync(saida).sort()).toEqual(['consultas.csv', 'eventos.csv']);
  });

  test('nenhum dado pessoal sai, em nenhum dos arquivos', async () => {
    await exportar({ saida: pasta, segredo: SEGREDO });

    for (const nome of ['consultas.csv', 'eventos.csv']) {
      const texto = fs.readFileSync(path.join(pasta, nome), 'utf8');
      for (const proibido of PROIBIDOS) {
        expect({ nome, proibido, presente: texto.includes(proibido) }).toEqual({
          nome,
          proibido,
          presente: false,
        });
      }
    }
  });

  test('consultas.csv: uma linha por consulta, com pseudônimos, cancelamento e pagamento', async () => {
    await exportar({ saida: pasta, segredo: SEGREDO });

    const { colunas, linhas } = lerCsv(path.join(pasta, 'consultas.csv'));

    expect(colunas).toEqual([
      'consulta',
      'paciente',
      'status',
      'motivo_cancelamento',
      'inicio',
      'criada_em',
      'paga',
      'lembrete_enviado_em',
    ]);
    expect(linhas).toEqual([
      expect.objectContaining({
        consulta: p.consulta(consultaDaAna),
        paciente: p.paciente(pacientes.a),
        status: 'cancelada',
        motivo_cancelamento: 'paciente',
        paga: '0',
      }),
      expect.objectContaining({
        consulta: p.consulta(consultaDoBruno),
        paciente: p.paciente(pacientes.b),
        status: 'pendente_pagamento',
        motivo_cancelamento: '',
        paga: '1',
      }),
    ]);
    for (const linha of linhas) {
      expect(new Date(linha.inicio).toISOString()).toBe(linha.inicio);
    }
  });

  test('eventos.csv: toda a auditoria, cada evento ligado ao paciente certo', async () => {
    await exportar({ saida: pasta, segredo: SEGREDO });

    const { colunas, linhas } = lerCsv(path.join(pasta, 'eventos.csv'));
    const { rows } = await consultar('SELECT count(*)::int AS n FROM auditoria');
    const doEvento = (acao) => linhas.filter((l) => l.acao === acao);

    expect(colunas).toEqual(['paciente', 'consulta', 'ator', 'acao', 'instante']);
    expect(linhas).toHaveLength(rows[0].n);

    // Evento sobre o próprio paciente.
    expect(doEvento('paciente.atualizado')).toEqual([
      expect.objectContaining({ paciente: p.paciente(pacientes.a), consulta: '', ator: 'paciente' }),
    ]);
    // Evento de aparelho: o paciente é quem agiu.
    expect(doEvento('dispositivo.registrado')).toEqual([
      expect.objectContaining({ paciente: p.paciente(pacientes.a), consulta: '' }),
    ]);
    // Evento sobre consulta: o dono dela.
    expect(doEvento('consulta.cancelada')).toEqual([
      expect.objectContaining({ paciente: p.paciente(pacientes.a), consulta: p.consulta(consultaDaAna) }),
    ]);
    // Evento sobre pagamento, feito pelo webhook: chega ao paciente pela consulta.
    expect(doEvento('pagamento.aprovado')).toEqual([
      expect.objectContaining({
        paciente: p.paciente(pacientes.b),
        consulta: p.consulta(consultaDoBruno),
        ator: 'webhook',
      }),
    ]);
  });

  test('os dois arquivos saem do mesmo instante do banco', async () => {
    // Um evento gravado por outra conexão ENTRE as duas leituras não pode
    // aparecer: lidas em separado, eventos.csv traria o que consultas.csv não
    // viu.
    const { rows } = await consultar('SELECT count(*)::int AS n FROM auditoria');
    let inserido;
    try {
      await exportar({
        saida: pasta,
        segredo: SEGREDO,
        entreAsLeituras: async () => {
          const r = await consultar(
            `INSERT INTO auditoria (ator_tipo, ator_id, acao, entidade, entidade_id, detalhe)
             VALUES ('paciente', $1, 'paciente.atualizado', 'paciente', $1, '{}') RETURNING id`,
            [pacientes.a]
          );
          inserido = r.rows[0].id;
        },
      });

      expect(lerCsv(path.join(pasta, 'eventos.csv')).linhas).toHaveLength(rows[0].n);
    } finally {
      if (inserido) await consultar('DELETE FROM auditoria WHERE id = $1', [inserido]);
    }
  });

  test('a leitura roda numa transação só leitura, e não pode escrever', async () => {
    const estado = {};

    await exportar({
      saida: pasta,
      segredo: SEGREDO,
      entreAsLeituras: async (cliente) => {
        estado.somenteLeitura = (await cliente.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
        estado.isolamento = (await cliente.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
      },
    });

    expect(estado).toEqual({ somenteLeitura: 'on', isolamento: 'repeatable read' });
  });

  test('o mesmo segredo dá os mesmos pseudônimos de uma exportação para outra', async () => {
    await exportar({ saida: path.join(pasta, '1'), segredo: SEGREDO });
    await exportar({ saida: path.join(pasta, '2'), segredo: SEGREDO });

    const ler = (sub) => fs.readFileSync(path.join(pasta, sub, 'consultas.csv'), 'utf8');
    expect(ler('2')).toBe(ler('1'));
  });

  test('recusa gravar dentro do repositório, e não cria nada lá', async () => {
    const dentro = path.join(RAIZ, 'docs', 'exportacao-que-nao-pode-existir');
    // Se a pasta já existisse, o teste não provaria nada — e a limpeza abaixo
    // apagaria o que não é dela.
    expect(fs.existsSync(dentro)).toBe(false);

    try {
      await expect(exportar({ saida: dentro, segredo: SEGREDO })).rejects.toThrow(Recusa);

      expect(fs.existsSync(dentro)).toBe(false);
    } finally {
      // Se a guarda falhar, o teste cai — mas não deixa dados de teste dentro
      // do repositório, esperando um `git add`.
      fs.rmSync(dentro, { recursive: true, force: true });
    }
  });

  test('recusa sobrescrever uma exportação anterior', async () => {
    await exportar({ saida: pasta, segredo: SEGREDO });
    const antes = fs.readFileSync(path.join(pasta, 'consultas.csv'), 'utf8');

    await expect(exportar({ saida: pasta, segredo: SEGREDO })).rejects.toThrow(/nunca sobrescreve/);

    expect(fs.readFileSync(path.join(pasta, 'consultas.csv'), 'utf8')).toBe(antes);
  });

  // Só no Windows: no Linux a raiz "/" sempre existe.
  (process.platform === 'win32' ? test : test.skip)(
    'disco que não existe é recusado com mensagem, e não com erro do sistema',
    async () => {
      const letra = 'ZYXWVUTSRQPONMLKJIHGFED'.split('').find((l) => !fs.existsSync(`${l}:\\`));

      await expect(exportar({ saida: `${letra}:\\pesquisa`, segredo: SEGREDO })).rejects.toThrow(
        /disco que não existe/
      );
    }
  );

  test('sem segredo adequado, não grava nada', async () => {
    const saida = path.join(pasta, 'sem-segredo');

    await expect(exportar({ saida, segredo: 'curto' })).rejects.toThrow(SegredoInadequado);

    expect(fs.existsSync(saida)).toBe(false);
  });
});
