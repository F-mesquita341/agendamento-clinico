'use strict';

/**
 * A rotina de lembretes, contra o PostgreSQL real, com dublê do provedor.
 *
 * O portão da etapa é "o lembrete chega uma única vez". Quase todos os testes
 * daqui são sobre isso: quem entra na janela, quem não entra, e o que acontece
 * quando o envio falha no meio.
 */

const { EnviarLembretes } = require('../../src/application/EnviarLembretes');
const { RepositorioDeConsultasPg } = require('../../src/infra/db/RepositorioDeConsultasPg');
const { RepositorioDeDispositivosPg } = require('../../src/infra/db/RepositorioDeDispositivosPg');
const { NotificadorFalso } = require('../helpers/notificadorFalso');
const { limpar } = require('../helpers/semente');
const { consultar, encerrar } = require('../../src/infra/db/pool');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../../src/domain/Paciente');

const HORAS = 60 * 60 * 1000;
const AGORA = new Date('2026-09-21T13:00:00Z');
const relogio = { agora: () => AGORA };

const consultas = new RepositorioDeConsultasPg();
const dispositivos = new RepositorioDeDispositivosPg();
let notificador;
let rotina;

beforeEach(async () => {
  await limpar();
  notificador = new NotificadorFalso();
  rotina = new EnviarLembretes({ consultas, dispositivos, notificador, relogio });
});

afterAll(() => encerrar());

/** Monta clínica, profissional, paciente, horário e consulta de uma vez. */
async function cenario({
  comecaDaquiA = 20 * HORAS,
  status = 'confirmada',
  lembreteEnviadoEm = null,
  aparelhos = ['token-do-aparelho'],
} = {}) {
  const { rows: clinicas } = await consultar(
    `INSERT INTO clinica (nome, cnpj) VALUES ('Clínica', '11.111.111/0001-11') RETURNING id`
  );
  const { rows: esp } = await consultar(
    `INSERT INTO especialidade (nome) VALUES ('Cardiologia') RETURNING id`
  );
  const { rows: profs } = await consultar(
    `INSERT INTO profissional (clinica_id, especialidade_id, nome, registro_conselho, valor_consulta_centavos)
     VALUES ($1, $2, 'José Antônio Ferreira', 'CRM-CE 11111', 25000) RETURNING id`,
    [clinicas[0].id, esp[0].id]
  );
  const { rows: pacientes } = await consultar(
    `INSERT INTO paciente (firebase_uid, nome, email, consentimento_versao, consentimento_em)
     VALUES ('uid-a', 'Paciente A', 'a@example.com', $1, now()) RETURNING id`,
    [VERSAO_TERMO_CONSENTIMENTO]
  );

  const inicio = new Date(AGORA.getTime() + comecaDaquiA);
  const { rows: horarios } = await consultar(
    `INSERT INTO horario (profissional_id, inicio, fim, status)
     VALUES ($1, $2::timestamptz, $2::timestamptz + INTERVAL '30 minutes', 'reservado')
     RETURNING id`,
    [profs[0].id, inicio.toISOString()]
  );

  // `periodo` sustenta a restrição de exclusão da migration 007, que impede o
  // mesmo paciente de ter duas consultas sobrepostas. Quem agenda pela API o
  // preenche; aqui a consulta é inserida direto, então é preciso repetir.
  const { rows: criadas } = await consultar(
    `INSERT INTO consulta (paciente_id, horario_id, status, valor_centavos, lembrete_enviado_em,
                           motivo_cancelamento, periodo)
     SELECT $1, h.id, $3, 25000, $4, $5, tstzrange(h.inicio, h.fim, '[)')
       FROM horario h WHERE h.id = $2
     RETURNING id`,
    [
      pacientes[0].id,
      horarios[0].id,
      status,
      lembreteEnviadoEm,
      status === 'cancelada' ? 'paciente' : null,
    ]
  );

  for (const token of aparelhos) {
    await dispositivos.registrar({ pacienteId: pacientes[0].id, token, plataforma: 'android' });
  }

  return { consultaId: Number(criadas[0].id), pacienteId: Number(pacientes[0].id), inicio };
}

async function marcaDoLembrete(consultaId) {
  const { rows } = await consultar('SELECT lembrete_enviado_em FROM consulta WHERE id = $1', [
    consultaId,
  ]);
  return rows[0].lembrete_enviado_em;
}

async function auditoriaDeLembrete() {
  const { rows } = await consultar(
    `SELECT ator_tipo, entidade_id, detalhe FROM auditoria WHERE acao = 'lembrete.enviado' ORDER BY id`
  );
  return rows;
}

async function tokensGuardados() {
  const { rows } = await consultar('SELECT token FROM dispositivo ORDER BY id');
  return rows.map((r) => r.token);
}

describe('quem recebe lembrete', () => {
  test('consulta confirmada dentro de 24 h é avisada e fica marcada', async () => {
    const { consultaId } = await cenario();

    const resultado = await rotina.executar();

    expect(resultado).toMatchObject({ enviados: 1, semAparelho: 0, adiados: 0, falhas: 0 });
    expect(notificador.quantidade).toBe(1);
    expect(await marcaDoLembrete(consultaId)).toEqual(AGORA);
  });

  test('a segunda rodada NÃO reenvia — é o portão da etapa', async () => {
    await cenario();

    await rotina.executar();
    const segunda = await rotina.executar();

    expect(segunda.enviados).toBe(0);
    expect(notificador.quantidade).toBe(1);
  });

  test.each([
    ['consulta de semana que vem', { comecaDaquiA: 7 * 24 * HORAS }],
    ['consulta que já começou', { comecaDaquiA: -1 * HORAS }],
    ['consulta ainda não paga', { status: 'pendente_pagamento' }],
    ['consulta cancelada', { status: 'cancelada' }],
    ['consulta já avisada', { lembreteEnviadoEm: new Date('2026-09-20T13:00:00Z') }],
  ])('%s não é avisada', async (_rotulo, opcoes) => {
    await cenario(opcoes);

    const resultado = await rotina.executar();

    expect(resultado.enviados).toBe(0);
    expect(notificador.quantidade).toBe(0);
  });

  test('paciente sem aparelho registrado não trava a rotina', async () => {
    // A marca fica mesmo assim: não há o que reenviar, e tentar a cada rodada
    // faria a rotina varrer a mesma consulta para sempre.
    const { consultaId } = await cenario({ aparelhos: [] });

    const resultado = await rotina.executar();

    expect(resultado).toMatchObject({ enviados: 0, semAparelho: 1 });
    expect(await marcaDoLembrete(consultaId)).toEqual(AGORA);
  });
});

describe('o que é enviado', () => {
  test('uma mensagem só, com todos os aparelhos do paciente', async () => {
    await cenario({ aparelhos: ['aparelho-1', 'aparelho-2'] });

    await rotina.executar();

    expect(notificador.quantidade).toBe(1);
    expect(notificador.enviados[0].tokens).toEqual(['aparelho-1', 'aparelho-2']);
  });

  test('o texto não revela especialidade nem profissional', async () => {
    // O cenário usa 'Cardiologia' e 'José Antônio Ferreira' de propósito.
    await cenario();

    await rotina.executar();

    const { titulo, corpo } = notificador.enviados[0];
    expect(`${titulo} ${corpo}`).not.toMatch(/cardiolog|josé|ferreira/i);
    expect(corpo).toMatch(/consulta amanhã às/);
  });

  test('leva o id da consulta, para o aplicativo saber que tela abrir', async () => {
    const { consultaId } = await cenario();

    await rotina.executar();

    expect(notificador.enviados[0].dados).toEqual({
      consultaId: String(consultaId),
      tipo: 'lembrete',
    });
  });
});

describe('auditoria', () => {
  test('registra o envio com a contagem de aparelhos, nunca os tokens', async () => {
    const { consultaId } = await cenario({ aparelhos: ['aparelho-1', 'aparelho-2'] });

    await rotina.executar();

    const linhas = await auditoriaDeLembrete();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ ator_tipo: 'sistema', entidade_id: String(consultaId) });
    expect(linhas[0].detalhe).toEqual({ aparelhos: 2 });
    expect(JSON.stringify(linhas[0].detalhe)).not.toContain('aparelho-1');
  });

  test('paciente sem aparelho não gera linha de envio', async () => {
    await cenario({ aparelhos: [] });

    await rotina.executar();

    expect(await auditoriaDeLembrete()).toEqual([]);
  });
});

describe('aparelhos que o provedor recusa', () => {
  test('token inexistente é apagado', async () => {
    await cenario({ aparelhos: ['vivo', 'morto'] });
    notificador.mortos.add('morto');

    await rotina.executar();

    expect(await tokensGuardados()).toEqual(['vivo']);
  });

  test('a auditoria conta só os que de fato receberam', async () => {
    await cenario({ aparelhos: ['vivo', 'morto'] });
    notificador.mortos.add('morto');

    await rotina.executar();

    expect((await auditoriaDeLembrete())[0].detalhe).toEqual({ aparelhos: 1 });
  });

  test('TODOS os aparelhos mortos não vira "enviado" nem linha de auditoria', async () => {
    // Ninguém recebeu. Contar como enviado e auditar "lembrete.enviado" com
    // zero aparelhos seria registrar entrega que não houve. A marca fica: os
    // tokens acabaram de ser apagados, não há o que reenviar.
    const { consultaId } = await cenario({ aparelhos: ['morto-1', 'morto-2'] });
    notificador.mortos.add('morto-1').add('morto-2');

    const resultado = await rotina.executar();

    expect(resultado).toMatchObject({ enviados: 0, semAparelho: 1 });
    expect(await auditoriaDeLembrete()).toEqual([]);
    expect(await tokensGuardados()).toEqual([]);
    expect(await marcaDoLembrete(consultaId)).toEqual(AGORA);
  });
});

describe('quando o provedor falha', () => {
  test('a marca é desfeita, e a rodada seguinte tenta de novo', async () => {
    // Sem desfazer, uma indisponibilidade momentânea consumiria o lembrete sem
    // entregá-lo, e ninguém perceberia: não há erro depois disso.
    const { consultaId } = await cenario();
    notificador.indisponivel = true;

    const primeira = await rotina.executar();

    expect(primeira).toMatchObject({ enviados: 0, adiados: 1, falhas: 0 });
    expect(await marcaDoLembrete(consultaId)).toBeNull();

    notificador.indisponivel = false;
    const segunda = await rotina.executar();

    expect(segunda.enviados).toBe(1);
    expect(await marcaDoLembrete(consultaId)).toEqual(AGORA);
  });

  test('falha ANTES da marca não apaga marca nenhuma', async () => {
    // Se o próprio `reservarLembrete` falhar, não há marca nossa para desfazer.
    // Chamar `desmarcarLembrete` ali seria apagar uma marca de origem
    // desconhecida — e apagá-la faria o lembrete sair de novo.
    const { consultaId } = await cenario();
    const original = consultas.reservarLembrete.bind(consultas);
    const desmarcar = jest.spyOn(consultas, 'desmarcarLembrete');
    jest
      .spyOn(consultas, 'reservarLembrete')
      .mockRejectedValueOnce(new Error('banco indisponível'));

    const resultado = await rotina.executar();

    expect(resultado).toMatchObject({ adiados: 1 });
    expect(desmarcar).not.toHaveBeenCalled();
    expect(await marcaDoLembrete(consultaId)).toBeNull();

    consultas.reservarLembrete = original;
    desmarcar.mockRestore();
  });

  test('uma consulta problemática não impede as outras', async () => {
    await cenario();
    notificador.indisponivel = true;

    // A rotina não pode estourar: ela roda sozinha, a cada intervalo.
    await expect(rotina.executar()).resolves.toMatchObject({ adiados: 1 });
  });
});
