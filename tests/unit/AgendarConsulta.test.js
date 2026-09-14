'use strict';

/**
 * O caso de uso roda inteiro sem PostgreSQL, sem Express e sem rede — é a
 * prova prática de que a regra de dependência foi respeitada.
 */

const { AgendarConsulta } = require('../../src/application/AgendarConsulta');
const { relogioFixo } = require('../../src/domain/Relogio');
const { criarRepositorios, umHorario } = require('../helpers/repositoriosFalsos');

const AGORA = new Date('2026-10-05T12:00:00-03:00');
const DAQUI_A_UMA_HORA = new Date('2026-10-05T13:00:00-03:00');
const ONTEM = new Date('2026-10-04T09:00:00-03:00');

function montar(horarios) {
  const repos = criarRepositorios(horarios);
  const caso = new AgendarConsulta({
    horarios: repos.horarios,
    consultas: repos.consultas,
    relogio: relogioFixo(AGORA),
    reservaMinutos: 15,
  });
  return { caso, ...repos };
}

describe('AgendarConsulta', () => {
  test('agenda quando o horário está livre e a versão confere', async () => {
    const horario = umHorario({ id: 1, inicio: DAQUI_A_UMA_HORA, versao: 0 });
    const { caso, horarios } = montar([horario]);

    const consulta = await caso.executar({ pacienteId: 7, horarioId: 1, versao: 0 });

    expect(consulta.pacienteId).toBe(7);
    expect(consulta.status).toBe('pendente_pagamento');
    expect(consulta.estaAtiva()).toBe(true);

    const depois = await horarios.porId(1);
    expect(depois.status).toBe('reservado');
    expect(depois.versao).toBe(1);
  });

  test('a reserva ganha prazo de expiração a partir de agora', async () => {
    const { caso } = montar([umHorario({ id: 1, inicio: DAQUI_A_UMA_HORA })]);

    const consulta = await caso.executar({ pacienteId: 7, horarioId: 1, versao: 0 });

    expect(consulta.reservaExpiraEm.getTime()).toBe(AGORA.getTime() + 15 * 60_000);
    expect(consulta.expirouAguardandoPagamento(AGORA)).toBe(false);
  });

  test('versão desatualizada é conflito, e não erro do sistema', async () => {
    const { caso } = montar([umHorario({ id: 1, inicio: DAQUI_A_UMA_HORA, versao: 3 })]);

    // O app leu a grade quando a versão era 2; alguém mexeu desde então.
    await expect(
      caso.executar({ pacienteId: 7, horarioId: 1, versao: 2 })
    ).rejects.toMatchObject({
      codigo: 'HORARIO_INDISPONIVEL',
      status: 409,
      acao: 'recarregar_horarios',
    });
  });

  test('duas pessoas no mesmo horário: a segunda recebe 409', async () => {
    const { caso, horarios } = montar([umHorario({ id: 1, inicio: DAQUI_A_UMA_HORA, versao: 0 })]);

    await caso.executar({ pacienteId: 7, horarioId: 1, versao: 0 });

    // A segunda pessoa ainda tem a versão 0 em mãos — leu a grade antes.
    await expect(
      caso.executar({ pacienteId: 8, horarioId: 1, versao: 0 })
    ).rejects.toMatchObject({ status: 409 });

    const consultasDoSegundo = await horarios.consultas.doPaciente(8);
    expect(consultasDoSegundo).toHaveLength(0);
  });

  test('não agenda horário que já começou', async () => {
    const { caso } = montar([umHorario({ id: 1, inicio: ONTEM })]);

    await expect(
      caso.executar({ pacienteId: 7, horarioId: 1, versao: 0 })
    ).rejects.toMatchObject({ codigo: 'HORARIO_NO_PASSADO', status: 422 });
  });

  test('não agenda horário que não existe', async () => {
    const { caso } = montar([]);

    await expect(
      caso.executar({ pacienteId: 7, horarioId: 999, versao: 0 })
    ).rejects.toMatchObject({ codigo: 'NAO_ENCONTRADO', status: 404 });
  });

  test('o mesmo paciente não fica em dois lugares ao mesmo tempo', async () => {
    const comA = umHorario({ id: 1, profissionalId: 10, inicio: DAQUI_A_UMA_HORA });
    const comB = umHorario({ id: 2, profissionalId: 20, inicio: DAQUI_A_UMA_HORA });
    const { caso } = montar([comA, comB]);

    await caso.executar({ pacienteId: 7, horarioId: 1, versao: 0 });

    await expect(
      caso.executar({ pacienteId: 7, horarioId: 2, versao: 0 })
    ).rejects.toMatchObject({ codigo: 'CONSULTA_SOBREPOSTA', status: 422 });
  });

  test('outro paciente pode usar o mesmo instante com outro profissional', async () => {
    const comA = umHorario({ id: 1, profissionalId: 10, inicio: DAQUI_A_UMA_HORA });
    const comB = umHorario({ id: 2, profissionalId: 20, inicio: DAQUI_A_UMA_HORA });
    const { caso } = montar([comA, comB]);

    await caso.executar({ pacienteId: 7, horarioId: 1, versao: 0 });
    const outra = await caso.executar({ pacienteId: 8, horarioId: 2, versao: 0 });

    expect(outra.pacienteId).toBe(8);
  });

  test('versão ausente é recusada antes de tocar no repositório', async () => {
    const { caso } = montar([umHorario({ id: 1, inicio: DAQUI_A_UMA_HORA })]);

    await expect(
      caso.executar({ pacienteId: 7, horarioId: 1, versao: undefined })
    ).rejects.toMatchObject({ codigo: 'VERSAO_AUSENTE' });
  });
});
