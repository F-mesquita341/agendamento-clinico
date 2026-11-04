'use strict';

/**
 * Versão 2, Etapa 21: agendar pagando com o plano ou na clínica, contra o
 * PostgreSQL real. O José (semente) aceita o plano Alfa; a Inês aceita pagar
 * na clínica. O fluxo pelo aplicativo tem os seus próprios testes, que não
 * mudaram — o caminho `app` é o mesmo de sempre.
 */

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { semear, semearPacientes } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { consultar } = require('../../src/infra/db/pool');
const { RepositorioDeConsultasPg } = require('../../src/infra/db/RepositorioDeConsultasPg');

const comoA = { Authorization: `Bearer ${tokenDe('uid-paciente-a', 'paciente.a@example.com')}` };
const consultasPg = new RepositorioDeConsultasPg();

let servidor;
let dados;
let pacientes;
let alfa;
let beta;

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(async () => {
  dados = await semear();
  pacientes = await semearPacientes();
  alfa = Number((await consultar(`INSERT INTO plano_de_saude (nome) VALUES ('Alfa Saúde') RETURNING id`)).rows[0].id);
  beta = Number((await consultar(`INSERT INTO plano_de_saude (nome) VALUES ('Beta Vida') RETURNING id`)).rows[0].id);
  await consultar(`INSERT INTO profissional_plano (profissional_id, plano_id) VALUES ($1, $2)`, [
    dados.profissionais.jose,
    alfa,
  ]);
  await consultar(`UPDATE profissional SET aceita_pagar_na_clinica = true WHERE id = $1`, [
    dados.profissionais.ines,
  ]);
});

afterAll(() => parar(servidor));

function agendar(corpo) {
  return request(servidor).post('/consultas').set(comoA).send(corpo);
}

async function horarioNoBanco(id) {
  const { rows } = await consultar('SELECT status, versao FROM horario WHERE id = $1', [id]);
  return rows[0];
}

async function contarConsultas() {
  const { rows } = await consultar('SELECT count(*)::int AS n FROM consulta');
  return rows[0].n;
}

describe('POST /consultas com plano ou na clínica', () => {
  test('com plano aceito: confirmada, sem prazo, com o plano', async () => {
    const r = await agendar({ horarioId: dados.horarios.amanha, versao: 0, formaDePagamento: 'plano', planoId: alfa });

    expect(r.status).toBe(201);
    expect(r.body.consulta).toMatchObject({
      status: 'confirmada',
      reservaExpiraEm: null,
      formaDePagamento: 'plano',
      plano: { id: alfa, nome: 'Alfa Saúde' },
      valorCentavos: 25000,
    });
    expect(await horarioNoBanco(dados.horarios.amanha)).toEqual({ status: 'reservado', versao: 1 });

    // A auditoria leva a forma, e não o plano: só identificadores.
    const { rows } = await consultar(
      `SELECT detalhe FROM auditoria WHERE acao = 'consulta.criada' AND entidade_id = $1`,
      [r.body.consulta.id]
    );
    expect(rows[0].detalhe).toMatchObject({ formaDePagamento: 'plano' });
    expect(JSON.stringify(rows[0].detalhe)).not.toMatch(/Alfa|plano_id|planoId/);
  });

  test('na clínica aceita: confirmada, sem prazo, sem plano', async () => {
    const r = await agendar({ horarioId: dados.horarios.amanhaComInes, versao: 0, formaDePagamento: 'clinica' });

    expect(r.status).toBe(201);
    expect(r.body.consulta).toMatchObject({
      status: 'confirmada',
      reservaExpiraEm: null,
      formaDePagamento: 'clinica',
      plano: null,
    });
  });

  test('"app" explícito é o mesmo que nenhuma forma: pendente, com prazo', async () => {
    const r = await agendar({ horarioId: dados.horarios.amanha, versao: 0, formaDePagamento: 'app' });

    expect(r.status).toBe(201);
    expect(r.body.consulta).toMatchObject({ status: 'pendente_pagamento', formaDePagamento: 'app', plano: null });
    expect(r.body.consulta.reservaExpiraEm).not.toBeNull();
  });

  test.each([
    ['plano que o profissional não aceita', () => ({ formaDePagamento: 'plano', planoId: beta }), 'PLANO_NAO_ACEITO'],
    ['plano que nem existe', () => ({ formaDePagamento: 'plano', planoId: 999999 }), 'PLANO_NAO_ACEITO'],
    ['clínica, que o José não aceita', () => ({ formaDePagamento: 'clinica' }), 'FORMA_DE_PAGAMENTO_NAO_ACEITA'],
  ])('%s: 422, e a reserva é desfeita', async (_rotulo, forma, codigo) => {
    const r = await agendar({ horarioId: dados.horarios.amanha, versao: 0, ...forma() });

    expect(r.status).toBe(422);
    expect(r.body.erro).toMatchObject({ codigo, acao: null });
    expect(r.body.erro.mensagem).toMatch(/Escolha outr/);
    expect(await horarioNoBanco(dados.horarios.amanha)).toEqual({ status: 'disponivel', versao: 0 });
    expect(await contarConsultas()).toBe(0);
  });

  test.each([
    ['plano sem planoId', { formaDePagamento: 'plano' }],
    ['planoId com clínica', { formaDePagamento: 'clinica', planoId: 1 }],
    ['planoId sem forma', { planoId: 1 }],
    ['forma desconhecida', { formaDePagamento: 'pix' }],
  ])('corpo inválido (%s): 422 DADOS_INVALIDOS, sem tocar no horário', async (_rotulo, extra) => {
    const r = await agendar({ horarioId: dados.horarios.amanha, versao: 0, ...extra });

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('DADOS_INVALIDOS');
    expect(await horarioNoBanco(dados.horarios.amanha)).toEqual({ status: 'disponivel', versao: 0 });
  });

  test('vinte pedidos simultâneos com plano: exatamente um vence', async () => {
    const respostas = await Promise.all(
      Array.from({ length: 20 }, () =>
        agendar({ horarioId: dados.horarios.amanha, versao: 0, formaDePagamento: 'plano', planoId: alfa })
      )
    );

    expect(respostas.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of respostas.filter((x) => x.status !== 201)) {
      expect(['HORARIO_INDISPONIVEL', 'CONSULTA_SOBREPOSTA']).toContain(r.body.erro.codigo);
    }
    expect(await contarConsultas()).toBe(1);
    expect(await horarioNoBanco(dados.horarios.amanha)).toEqual({ status: 'reservado', versao: 1 });
  });
});

describe('a consulta de plano depois de agendada', () => {
  async function comPlano() {
    const r = await agendar({ horarioId: dados.horarios.amanha, versao: 0, formaDePagamento: 'plano', planoId: alfa });
    expect(r.status).toBe(201);
    return r.body.consulta;
  }

  test('o detalhe e a lista trazem a forma e o plano', async () => {
    const consulta = await comPlano();

    const detalhe = await request(servidor).get(`/consultas/${consulta.id}`).set(comoA);
    const lista = await request(servidor).get('/consultas').set(comoA);

    for (const c of [detalhe.body.consulta, lista.body.consultas[0]]) {
      expect(c).toMatchObject({ formaDePagamento: 'plano', plano: { id: alfa, nome: 'Alfa Saúde' }, status: 'confirmada' });
    }
  });

  test('não se paga pelo aplicativo', async () => {
    const consulta = await comPlano();

    const r = await request(servidor).post(`/consultas/${consulta.id}/pagamento`).set(comoA);

    expect(r.status).toBe(422);
    expect(r.body.erro).toMatchObject({
      codigo: 'CONSULTA_NAO_PAGAVEL',
      mensagem: 'Esta consulta não é paga pelo aplicativo.',
    });
  });

  test('cancela antes do início, e não depois — a regra do bloco A vale igual', async () => {
    const antes = await comPlano();
    const r = await request(servidor).patch(`/consultas/${antes.id}/cancelamento`).set(comoA);
    expect(r.status).toBe(200);
    expect(r.body.consulta).toMatchObject({ status: 'cancelada', formaDePagamento: 'plano' });

    const depois = (
      await agendar({ horarioId: dados.horarios.comVersao7, versao: 7, formaDePagamento: 'plano', planoId: alfa })
    ).body.consulta;
    await consultar(
      `UPDATE horario SET inicio = now() - INTERVAL '30 minutes', fim = now() WHERE id = $1`,
      [dados.horarios.comVersao7]
    );
    const tarde = await request(servidor).patch(`/consultas/${depois.id}/cancelamento`).set(comoA);
    expect(tarde.status).toBe(422);
    expect(tarde.body.erro.codigo).toBe('CONSULTA_JA_INICIADA');
  });

  test('a rotina de expiração não a enxerga; a de lembrete, sim', async () => {
    const consulta = await comPlano();
    await consultar(
      `INSERT INTO dispositivo (paciente_id, token, plataforma) VALUES ($1, 'token-v2', 'android')`,
      [pacientes.a]
    );

    const daquiADuasHoras = new Date(Date.now() + 2 * 3600_000);
    const vencidas = await consultasPg.reservasVencidas(daquiADuasHoras, 100);
    expect(vencidas.map((v) => v.consultaId)).not.toContain(consulta.id);

    const lembrar = await consultasPg.aguardandoLembrete(new Date(Date.now() + 60_000), 100);
    expect(lembrar).toContain(consulta.id);
  });
});

describe('as restrições da migration 011', () => {
  async function inserir(extra) {
    const colunas = Object.keys(extra).join(', ');
    const valores = Object.keys(extra).map((_, i) => `$${i + 3}`).join(', ');
    return consultar(
      `INSERT INTO consulta (paciente_id, horario_id, valor_centavos, periodo, ${colunas})
       SELECT $1, h.id, 1000, tstzrange(h.inicio, h.fim), ${valores} FROM horario h WHERE h.id = $2`,
      [pacientes.a, dados.horarios.amanha, ...Object.values(extra)]
    );
  }

  test.each([
    ['plano sem plano_id', { forma_de_pagamento: 'plano', status: 'confirmada' }, 'consulta_plano_so_com_forma_plano'],
    ['plano_id fora da forma plano', { forma_de_pagamento: 'clinica', status: 'confirmada', plano_id: null }, null],
    ['clínica pendente de pagamento', { forma_de_pagamento: 'clinica', status: 'pendente_pagamento' }, 'consulta_pendente_so_pelo_app'],
    ['clínica com prazo de reserva', { forma_de_pagamento: 'clinica', status: 'confirmada', reserva_expira_em: new Date() }, 'consulta_reserva_so_pelo_app'],
    ['forma desconhecida', { forma_de_pagamento: 'pix', status: 'confirmada' }, 'consulta_forma_de_pagamento_conhecida'],
  ])('%s', async (_rotulo, extra, restricao) => {
    if (restricao === null) {
      // Controle: a combinação válida passa — a restrição não é larga demais.
      await expect(inserir(extra)).resolves.toBeDefined();
      return;
    }
    await expect(inserir(extra)).rejects.toMatchObject({ constraint: restricao });
  });

  test('plano_id com forma clínica é recusado', async () => {
    await expect(
      inserir({ forma_de_pagamento: 'clinica', status: 'confirmada', plano_id: alfa })
    ).rejects.toMatchObject({ constraint: 'consulta_plano_so_com_forma_plano' });
  });
});
