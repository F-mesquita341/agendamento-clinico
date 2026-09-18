'use strict';

/**
 * Agendamento e cancelamento, de ponta a ponta contra o PostgreSQL real.
 *
 * É o teste mais importante do trabalho: o lock otimista só existe de verdade
 * quando duas transações concorrentes disputam a mesma linha. Dublê em memória
 * não prova isso — prova a lógica ao redor. Por isso tudo aqui é real, exceto o
 * verificador de token, que cumpre o mesmo contrato do Firebase sem precisar de
 * rede na integração contínua.
 */

const request = require('supertest');
const { iniciar, parar } = require('../helpers/servidor');
const { semear, semearPacientes } = require('../helpers/semente');
const { tokenDe } = require('../helpers/verificadorFalso');
const { consultar } = require('../../src/infra/db/pool');
const { RepositorioDeConsultasPg } = require('../../src/infra/db/RepositorioDeConsultasPg');

const comoA = { Authorization: `Bearer ${tokenDe('uid-paciente-a', 'paciente.a@example.com')}` };
const comoB = { Authorization: `Bearer ${tokenDe('uid-paciente-b', 'paciente.b@example.com')}` };
const SEM_PERFIL = { Authorization: `Bearer ${tokenDe('uid-sem-perfil', 'sem@example.com')}` };

const consultasPg = new RepositorioDeConsultasPg();

let servidor;
let dados;
let pacientes;

beforeAll(async () => {
  servidor = await iniciar();
});

beforeEach(async () => {
  dados = await semear();
  pacientes = await semearPacientes();
});

afterAll(() => parar(servidor));

function agendar(cabecalhos, corpo) {
  return request(servidor).post('/consultas').set(cabecalhos).send(corpo);
}

function cancelar(cabecalhos, consultaId) {
  return request(servidor).patch(`/consultas/${consultaId}/cancelamento`).set(cabecalhos);
}

/** Agenda e devolve o corpo da consulta criada, falhando alto se não vier 201. */
async function agendado(cabecalhos, horarioId, versao = 0) {
  const r = await agendar(cabecalhos, { horarioId, versao });
  expect(r.status).toBe(201);
  return r.body.consulta;
}

async function horarioNoBanco(id) {
  const { rows } = await consultar('SELECT status, versao FROM horario WHERE id = $1', [id]);
  return rows[0];
}

async function contarConsultas(condicao = 'TRUE') {
  const { rows } = await consultar(`SELECT count(*)::int AS n FROM consulta WHERE ${condicao}`);
  return rows[0].n;
}

describe('POST /consultas', () => {
  test('agenda com o preço do profissional e prazo de reserva', async () => {
    const r = await agendar(comoA, { horarioId: dados.horarios.amanha, versao: 0 });

    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(`/consultas/${r.body.consulta.id}`);
    expect(r.body.consulta).toMatchObject({
      status: 'pendente_pagamento',
      horarioId: dados.horarios.amanha,
      // O preço é o do José no seed, lido do profissional dentro da transação.
      // Zero aqui significaria que o valor voltou a ser lido do horário.
      valorCentavos: 25000,
      valorFormatado: 'R$ 250,00',
    });

    const esperado = Date.now() + 15 * 60_000;
    const expira = new Date(r.body.consulta.reservaExpiraEm).getTime();
    expect(Math.abs(expira - esperado)).toBeLessThan(60_000);

    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({
      status: 'reservado',
      versao: 1,
    });
  });

  test('PORTÃO: a segunda requisição com a mesma versão recebe 409 e não cria consulta', async () => {
    await agendado(comoA, dados.horarios.amanha, 0);

    // B leu a grade antes de A agendar, então ainda tem a versão 0 em mãos.
    const segunda = await agendar(comoB, { horarioId: dados.horarios.amanha, versao: 0 });

    expect(segunda.status).toBe(409);
    expect(segunda.body.erro).toMatchObject({
      codigo: 'HORARIO_INDISPONIVEL',
      acao: 'recarregar_horarios',
    });
    expect(await contarConsultas()).toBe(1);
    // Uma única reserva bem-sucedida, um único incremento.
    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({ versao: 1 });
  });

  test('vinte requisições simultâneas: exatamente uma vence', async () => {
    const respostas = await Promise.all(
      Array.from({ length: 20 }, () =>
        agendar(comoA, { horarioId: dados.horarios.amanha, versao: 0 })
      )
    );

    const criadas = respostas.filter((r) => r.status === 201);
    expect(criadas).toHaveLength(1);

    // As perdedoras são recusas legítimas de dois tipos: 409 quando perderam a
    // disputa pela versão, e 422 CONSULTA_SOBREPOSTA quando a checagem prévia
    // rodou depois de a vencedora ter gravado — nesse instante o horário já
    // conflita com a agenda do próprio paciente. Nenhuma delas cria consulta.
    for (const r of respostas.filter((x) => x.status !== 201)) {
      expect([409, 422]).toContain(r.status);
      expect(['HORARIO_INDISPONIVEL', 'CONSULTA_SOBREPOSTA']).toContain(r.body.erro.codigo);
    }

    expect(await contarConsultas()).toBe(1);
    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({
      status: 'reservado',
      versao: 1,
    });
  });

  test('versão desatualizada é recusada mesmo com o horário livre', async () => {
    // Este horário está em 'disponivel', mas na versão 7.
    const r = await agendar(comoA, { horarioId: dados.horarios.comVersao7, versao: 0 });

    expect(r.status).toBe(409);
    expect(await contarConsultas()).toBe(0);
    expect(await horarioNoBanco(dados.horarios.comVersao7)).toMatchObject({
      status: 'disponivel',
      versao: 7,
    });
  });

  test('horário já reservado por outra pessoa é 409', async () => {
    const r = await agendar(comoA, { horarioId: dados.horarios.reservado, versao: 1 });

    expect(r.status).toBe(409);
    expect(await contarConsultas()).toBe(0);
  });

  test('horário que já começou é 422', async () => {
    const r = await agendar(comoA, { horarioId: dados.horarios.passado, versao: 0 });

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('HORARIO_NO_PASSADO');
    expect(await contarConsultas()).toBe(0);
  });

  test('horário inexistente é 404', async () => {
    const r = await agendar(comoA, { horarioId: 999999, versao: 0 });

    expect(r.status).toBe(404);
    expect(r.body.erro.codigo).toBe('NAO_ENCONTRADO');
  });

  test('horário de profissional desativado é recusado, e a reserva é desfeita', async () => {
    const horario = dados.horarios.deProfissionalInativo;
    const r = await agendar(comoA, { horarioId: horario, versao: 0 });

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('PROFISSIONAL_INDISPONIVEL');
    expect(await contarConsultas()).toBe(0);
    // O UPDATE do horário aconteceu antes da recusa; se o ROLLBACK não tivesse
    // desfeito, o horário ficaria reservado para sempre, sem consulta nenhuma.
    expect(await horarioNoBanco(horario)).toMatchObject({ status: 'disponivel', versao: 0 });
  });

  test('o mesmo paciente não fica em dois lugares ao mesmo tempo', async () => {
    await agendado(comoA, dados.horarios.amanha, 0);

    const r = await agendar(comoA, { horarioId: dados.horarios.amanhaComInes, versao: 0 });

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CONSULTA_SOBREPOSTA');
  });

  test('dois pedidos simultâneos em horários sobrepostos: só um vence', async () => {
    // Horários DIFERENTES, no mesmo instante, com profissionais diferentes. O
    // lock otimista não protege este caso: cada pedido reserva a sua própria
    // linha de horário, sem chave em comum. As duas checagens de agenda rodam
    // antes de qualquer gravação e as duas veem "sem conflito" — por isso quem
    // precisa recusar é o banco.
    const respostas = await Promise.all([
      agendar(comoA, { horarioId: dados.horarios.amanha, versao: 0 }),
      agendar(comoA, { horarioId: dados.horarios.amanhaComInes, versao: 0 }),
    ]);
    const status = respostas.map((r) => r.status).sort();

    expect(status).toEqual([201, 422]);
    expect(respostas.find((r) => r.status === 422).body.erro.codigo).toBe('CONSULTA_SOBREPOSTA');
    expect(await contarConsultas("status <> 'cancelada'")).toBe(1);
  });

  test('outro paciente pode usar o mesmo instante com outro profissional', async () => {
    await agendado(comoA, dados.horarios.amanha, 0);
    await agendado(comoB, dados.horarios.amanhaComInes, 0);

    expect(await contarConsultas()).toBe(2);
  });

  test.each([
    ['sem versão', { horarioId: 1 }],
    ['versão em texto', { horarioId: 1, versao: 'zero' }],
    ['sem horário', { versao: 0 }],
    ['campo não permitido', { horarioId: 1, versao: 0, pacienteId: 2 }],
    ['nome em snake_case', { horario_id: 1, versao: 0 }],
    // z.coerce.number() converteria estes três em 1, 7 e 5 — e agendaria um
    // horário que o paciente não escolheu.
    ['horário booleano', { horarioId: true, versao: 0 }],
    ['horário em array', { horarioId: [7], versao: 0 }],
    ['horário em texto', { horarioId: '5', versao: 0 }],
    ['horário grande demais', { horarioId: 1e21, versao: 0 }],
    ['versão acima do limite da coluna', { horarioId: 1, versao: 2_147_483_648 }],
  ])('corpo inválido (%s) é 422 em português', async (_rotulo, corpo) => {
    const r = await agendar(comoA, corpo);

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('DADOS_INVALIDOS');
    for (const problema of r.body.erro.problemas) {
      expect(problema.mensagem).not.toMatch(/Expected|Received|Invalid|String|Number/);
    }
    expect(await contarConsultas()).toBe(0);
  });

  test('sem token é 401 e com token sem perfil é 404', async () => {
    const semToken = await request(servidor)
      .post('/consultas')
      .send({ horarioId: dados.horarios.amanha, versao: 0 });
    expect(semToken.status).toBe(401);

    const semPerfil = await agendar(SEM_PERFIL, {
      horarioId: dados.horarios.amanha,
      versao: 0,
    });
    expect(semPerfil.status).toBe(404);
    expect(semPerfil.body.erro).toMatchObject({
      codigo: 'PERFIL_NAO_CADASTRADO',
      acao: 'completar_cadastro',
    });
    expect(await contarConsultas()).toBe(0);
  });

  test('o agendamento gera auditoria sem dado clínico', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);

    const { rows } = await consultar(
      `SELECT ator_tipo, ator_id, acao, entidade, entidade_id, detalhe
         FROM auditoria WHERE entidade = 'consulta'`
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ator_tipo: 'paciente',
      ator_id: String(pacientes.a),
      acao: 'consulta.criada',
      entidade_id: String(consulta.id),
    });
    // Nada de nome de profissional, especialidade ou motivo: a tabela de
    // auditoria não é lugar de dado sensível.
    expect(JSON.stringify(rows[0].detalhe)).not.toMatch(/José|Cardiologia|Ana/);
  });

  test('respostas de consulta não ficam em cache', async () => {
    const r = await agendar(comoA, { horarioId: dados.horarios.amanha, versao: 0 });

    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /consultas', () => {
  test('lista só as consultas do token, com horário e profissional', async () => {
    await agendado(comoA, dados.horarios.amanha, 0);
    await agendado(comoB, dados.horarios.amanhaComInes, 0);

    const r = await request(servidor).get('/consultas').set(comoA);

    expect(r.status).toBe(200);
    expect(r.body.consultas).toHaveLength(1);
    expect(r.body.consultas[0]).toMatchObject({
      status: 'pendente_pagamento',
      profissional: { nome: 'José Antônio Ferreira' },
    });
    expect(r.body.consultas[0].horario.inicio).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('pagina e informa o total', async () => {
    await agendado(comoA, dados.horarios.amanha, 0);
    await agendado(comoA, dados.horarios.comVersao7, 7);

    const r = await request(servidor).get('/consultas?limite=1&pagina=1').set(comoA);

    expect(r.body.consultas).toHaveLength(1);
    expect(r.body.paginacao).toMatchObject({ pagina: 1, limite: 1, total: 2, paginas: 2 });
  });

  test('consulta cancelada continua no histórico', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);
    await cancelar(comoA, consulta.id);

    const r = await request(servidor).get('/consultas').set(comoA);

    expect(r.body.consultas).toHaveLength(1);
    expect(r.body.consultas[0].status).toBe('cancelada');
  });
});

describe('GET /consultas/:id', () => {
  test('o dono lê a própria consulta', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);

    const r = await request(servidor).get(`/consultas/${consulta.id}`).set(comoA);

    expect(r.status).toBe(200);
    expect(r.body.consulta).toMatchObject({
      id: consulta.id,
      horario: { id: dados.horarios.amanha },
    });
  });

  test('consulta de outro paciente é 404 — a existência não é revelada', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);

    const alheia = await request(servidor).get(`/consultas/${consulta.id}`).set(comoB);
    const inexistente = await request(servidor).get('/consultas/999999').set(comoB);

    // As duas respostas precisam ser indistinguíveis: é isso que impede
    // percorrer /consultas/1..N e contar os registros da clínica.
    expect(alheia.status).toBe(404);
    expect(alheia.body).toEqual(inexistente.body);
  });

  test('id inexistente é 404 e id malformado é 422', async () => {
    expect((await request(servidor).get('/consultas/999999').set(comoA)).status).toBe(404);
    expect((await request(servidor).get('/consultas/abc').set(comoA)).status).toBe(422);
  });
});

describe('PATCH /consultas/:id/cancelamento', () => {
  test('devolve o horário à grade e mantém a consulta no histórico', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);

    const r = await cancelar(comoA, consulta.id);

    expect(r.status).toBe(200);
    expect(r.body.consulta.status).toBe('cancelada');
    // Versão 2: uma pela reserva, outra pela devolução. O aplicativo que ainda
    // tiver a versão 1 em mãos precisa recarregar a grade.
    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({
      status: 'disponivel',
      versao: 2,
    });
    // A consulta não é apagada — é matéria-prima da análise de absenteísmo.
    expect(await contarConsultas()).toBe(1);
  });

  test('o horário liberado pode ser agendado por outra pessoa', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);
    await cancelar(comoA, consulta.id);

    // Prova que o índice único é PARCIAL: a consulta cancelada continua na
    // tabela e não bloqueia o horário.
    await agendado(comoB, dados.horarios.amanha, 2);

    expect(await contarConsultas("status <> 'cancelada'")).toBe(1);
  });

  test('cancelar duas vezes é recusado na segunda', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);
    await cancelar(comoA, consulta.id);

    const r = await cancelar(comoA, consulta.id);

    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CONSULTA_JA_CANCELADA');
  });

  test('cancelamento repetido não rouba o horário de quem reservou depois', async () => {
    const daA = await agendado(comoA, dados.horarios.amanha, 0);
    await cancelar(comoA, daA.id);
    await agendado(comoB, dados.horarios.amanha, 2);

    // O aplicativo de A reenvia o cancelamento — conexão instável, botão
    // clicado duas vezes. Sem a cláusula que impede recancelar, isto liberaria
    // o horário que agora é de B.
    const repetido = await cancelar(comoA, daA.id);

    expect(repetido.status).toBe(422);
    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({
      status: 'reservado',
      versao: 3,
    });
  });

  test('dois cancelamentos simultâneos liberam o horário uma única vez', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);

    const respostas = await Promise.all([
      cancelar(comoA, consulta.id),
      cancelar(comoA, consulta.id),
    ]);
    const status = respostas.map((r) => r.status).sort();

    expect(status).toEqual([200, 422]);
    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({
      status: 'disponivel',
      versao: 2,
    });
  });

  test('a trava do adaptador recusa o segundo cancelamento simultâneo', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);

    // Direto no adaptador, sem passar pelo caso de uso: pelo HTTP, a checagem
    // prévia dele costuma pegar o segundo pedido antes de chegar aqui — e esta
    // trava existe justamente para quando ela NÃO pega, que é o caso em que as
    // duas requisições leem o estado antes de qualquer uma gravar.
    const resultados = await Promise.allSettled([
      consultasPg.cancelar(consulta.id),
      consultasPg.cancelar(consulta.id),
    ]);

    const recusados = resultados.filter((r) => r.status === 'rejected');
    expect(recusados).toHaveLength(1);
    expect(recusados[0].reason).toMatchObject({ codigo: 'CONSULTA_JA_CANCELADA' });

    // Um único incremento: o horário foi devolvido à grade uma vez só.
    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({
      status: 'disponivel',
      versao: 2,
    });

    const { rows } = await consultar(
      `SELECT count(*)::int AS n FROM auditoria WHERE acao = 'consulta.cancelada'`
    );
    expect(rows[0].n).toBe(1);
  });

  test('cancelar consulta de outro paciente é 404 e nada muda', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);

    const r = await cancelar(comoB, consulta.id);

    expect(r.status).toBe(404);
    expect(await horarioNoBanco(dados.horarios.amanha)).toMatchObject({
      status: 'reservado',
      versao: 1,
    });
    expect(await contarConsultas("status = 'pendente_pagamento'")).toBe(1);
  });

  test('o cancelamento gera auditoria', async () => {
    const consulta = await agendado(comoA, dados.horarios.amanha, 0);
    await cancelar(comoA, consulta.id);

    const { rows } = await consultar(
      `SELECT acao FROM auditoria WHERE entidade = 'consulta' ORDER BY id`
    );

    expect(rows.map((l) => l.acao)).toEqual(['consulta.criada', 'consulta.cancelada']);
  });
});
