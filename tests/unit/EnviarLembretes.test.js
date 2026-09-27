'use strict';

/**
 * EnviarLembretes com dublês, sem banco.
 *
 * O comportamento completo — marca, auditoria, tokens mortos, provedor fora do
 * ar — é provado contra o PostgreSQL em tests/integration/lembretes.test.js.
 * Aqui fica a regra do contrato de `aguardandoLembrete` que o dublê também
 * precisa cumprir: sem aparelho, a consulta nem é reservada, e o lembrete não
 * é consumido.
 */

const { AgendarConsulta } = require('../../src/application/AgendarConsulta');
const { EnviarLembretes } = require('../../src/application/EnviarLembretes');
const { STATUS_CONSULTA } = require('../../src/domain/Consulta');
const { relogioFixo } = require('../../src/domain/Relogio');
const { RepositorioDeDispositivos } = require('../../src/domain/repositorios');
const { criarRepositorios, umHorario } = require('../helpers/repositoriosFalsos');
const { NotificadorFalso } = require('../helpers/notificadorFalso');

const AGORA = new Date('2026-10-05T12:00:00-03:00');
const AMANHA_CEDO = new Date('2026-10-06T08:30:00-03:00');
const PACIENTE = 7;

/** Só o que a rotina usa; o resto do contrato responde "não implementado". */
class DispositivosFalsos extends RepositorioDeDispositivos {
  constructor() {
    super();
    this.tokens = new Map();
  }

  async doPaciente(pacienteId) {
    return this.tokens.get(String(pacienteId)) ?? [];
  }

  async esquecer() {}
}

async function cenario() {
  const repos = criarRepositorios([umHorario({ id: 1, inicio: AMANHA_CEDO })]);
  const relogio = relogioFixo(AGORA);
  const agendada = await new AgendarConsulta({ ...repos, relogio }).executar({
    pacienteId: PACIENTE,
    horarioId: 1,
    versao: 0,
  });
  // Paga: é o que o webhook faria.
  const consulta = await repos.consultas.porId(agendada.id);
  consulta.status = STATUS_CONSULTA.CONFIRMADA;

  const dispositivos = new DispositivosFalsos();
  const notificador = new NotificadorFalso();
  const rotina = new EnviarLembretes({ consultas: repos.consultas, dispositivos, notificador, relogio });
  return { ...repos, consulta, dispositivos, notificador, rotina };
}

describe('EnviarLembretes', () => {
  test('sem aparelho, a consulta nem é reservada, e o lembrete fica para depois', async () => {
    const { consultas, consulta, notificador, rotina } = await cenario();
    const reservar = jest.spyOn(consultas, 'reservarLembrete');

    const resultado = await rotina.executar();

    expect(reservar).not.toHaveBeenCalled();
    expect(resultado.enviados).toBe(0);
    expect(notificador.quantidade).toBe(0);
    expect(consulta.lembreteEnviadoEm).toBeNull();
  });

  test('com aparelho, o lembrete sai uma vez só', async () => {
    const { consultas, dispositivos, notificador, rotina } = await cenario();
    dispositivos.tokens.set(String(PACIENTE), ['aparelho-1']);
    consultas.pacientesComAparelho.add(String(PACIENTE));

    const primeira = await rotina.executar();
    const segunda = await rotina.executar();

    expect(primeira.enviados).toBe(1);
    expect(segunda.enviados).toBe(0);
    expect(notificador.quantidade).toBe(1);
  });
});
