'use strict';

/**
 * Cancelamento: o caso de uso que devolve o horário à grade.
 *
 * O ponto mais importante coberto aqui é que a consulta NÃO é apagada — ela
 * muda de estado. O registro precisa sobreviver: é matéria-prima da análise de
 * absenteísmo, que é o problema central investigado no trabalho.
 */

const { AgendarConsulta } = require('../../src/application/AgendarConsulta');
const { CancelarConsulta } = require('../../src/application/CancelarConsulta');
const { relogioFixo } = require('../../src/domain/Relogio');
const { criarRepositorios, umHorario } = require('../helpers/repositoriosFalsos');

const AGORA = new Date('2026-10-05T12:00:00-03:00');
const DAQUI_A_UMA_HORA = new Date('2026-10-05T13:00:00-03:00');

/** Monta o cenário com uma consulta já agendada pelo paciente informado. */
async function comConsultaAgendada({ pacienteId = 7 } = {}) {
  const horario = umHorario({ id: 1, inicio: DAQUI_A_UMA_HORA, versao: 0 });
  const repos = criarRepositorios([horario]);

  const agendar = new AgendarConsulta({
    horarios: repos.horarios,
    consultas: repos.consultas,
    relogio: relogioFixo(AGORA),
  });
  const cancelar = new CancelarConsulta({ consultas: repos.consultas });

  const consulta = await agendar.executar({ pacienteId, horarioId: 1, versao: 0 });

  return { ...repos, agendar, cancelar, consulta, horario };
}

describe('CancelarConsulta', () => {
  test('o dono cancela e a consulta muda de estado, sem ser apagada', async () => {
    const { cancelar, consultas, consulta } = await comConsultaAgendada();

    await cancelar.executar({ pacienteId: 7, consultaId: consulta.id });

    const depois = await consultas.porId(consulta.id);
    expect(depois).not.toBeNull();
    expect(depois.status).toBe('cancelada');
    expect(depois.estaAtiva()).toBe(false);
  });

  test('o horário volta para a grade, com a versão incrementada', async () => {
    const { cancelar, horarios, consulta } = await comConsultaAgendada();

    // Agendar já levou a versão de 0 para 1.
    expect((await horarios.porId(1)).versao).toBe(1);

    await cancelar.executar({ pacienteId: 7, consultaId: consulta.id });

    const horario = await horarios.porId(1);
    expect(horario.status).toBe('disponivel');
    // Incrementa de novo: quem tiver a versão 1 em mãos precisa recarregar.
    expect(horario.versao).toBe(2);
  });

  test('o horário liberado pode ser agendado por outra pessoa', async () => {
    const { cancelar, agendar, horarios, consulta } = await comConsultaAgendada();

    await cancelar.executar({ pacienteId: 7, consultaId: consulta.id });

    const versaoAtual = (await horarios.porId(1)).versao;
    const nova = await agendar.executar({
      pacienteId: 8,
      horarioId: 1,
      versao: versaoAtual,
    });

    expect(nova.pacienteId).toBe(8);
    expect(nova.status).toBe('pendente_pagamento');
  });

  test('cancelar consulta de outro paciente é 403, não 404', async () => {
    const { cancelar, consulta } = await comConsultaAgendada();

    // 404 revelaria que a consulta existe; 403 é a resposta correta para
    // recurso alheio, e é o que o contrato da API declara.
    await expect(
      cancelar.executar({ pacienteId: 99, consultaId: consulta.id })
    ).rejects.toMatchObject({ codigo: 'ACESSO_NEGADO', status: 403 });
  });

  test('o recurso alheio permanece intacto depois da tentativa', async () => {
    const { cancelar, consultas, horarios, consulta } = await comConsultaAgendada();

    await expect(
      cancelar.executar({ pacienteId: 99, consultaId: consulta.id })
    ).rejects.toThrow();

    expect((await consultas.porId(consulta.id)).status).toBe('pendente_pagamento');
    expect((await horarios.porId(1)).status).toBe('reservado');
  });

  test('cancelar duas vezes é recusado na segunda', async () => {
    const { cancelar, consulta } = await comConsultaAgendada();

    await cancelar.executar({ pacienteId: 7, consultaId: consulta.id });

    await expect(
      cancelar.executar({ pacienteId: 7, consultaId: consulta.id })
    ).rejects.toMatchObject({ codigo: 'CONSULTA_JA_CANCELADA', status: 422 });
  });

  test('consulta já realizada não pode ser cancelada', async () => {
    const { cancelar, consultas, consulta } = await comConsultaAgendada();

    (await consultas.porId(consulta.id)).status = 'realizada';

    await expect(
      cancelar.executar({ pacienteId: 7, consultaId: consulta.id })
    ).rejects.toMatchObject({ codigo: 'CONSULTA_NAO_CANCELAVEL', status: 422 });
  });

  test('consulta inexistente responde 404', async () => {
    const { cancelar } = await comConsultaAgendada();

    await expect(
      cancelar.executar({ pacienteId: 7, consultaId: 999999 })
    ).rejects.toMatchObject({ codigo: 'NAO_ENCONTRADO', status: 404 });
  });
});
