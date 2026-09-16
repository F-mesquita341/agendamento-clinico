'use strict';

/**
 * Cadastro e atualização de perfil, sem banco e sem Firebase.
 *
 * A identidade chega como `{ uid, email }` — o formato que o verificador de
 * token entrega depois de validar o token. Os casos de uso nunca leem e-mail
 * nem uid do corpo da requisição.
 */

const { CadastrarPaciente } = require('../../src/application/CadastrarPaciente');
const { AtualizarPerfil } = require('../../src/application/AtualizarPerfil');
const { Paciente, VERSAO_TERMO_CONSENTIMENTO } = require('../../src/domain/Paciente');
const { relogioFixo } = require('../../src/domain/Relogio');
const { PacientesFalsos } = require('../helpers/repositoriosFalsos');

const AGORA = new Date('2026-09-20T10:00:00-03:00');
const IDENTIDADE_A = { uid: 'uid-a', email: 'paciente.a@example.com' };
const IDENTIDADE_B = { uid: 'uid-b', email: 'paciente.b@example.com' };
const ACEITE = { aceito: true, versao: VERSAO_TERMO_CONSENTIMENTO };

function montar() {
  const pacientes = new PacientesFalsos();
  return {
    pacientes,
    cadastrar: new CadastrarPaciente({ pacientes, relogio: relogioFixo(AGORA) }),
    atualizar: new AtualizarPerfil({ pacientes }),
  };
}

describe('consentimento', () => {
  test('aceite da versão vigente é válido', () => {
    expect(() => Paciente.garantirConsentimento(ACEITE)).not.toThrow();
  });

  test.each([
    ['ausente', undefined],
    ['recusado', { aceito: false, versao: VERSAO_TERMO_CONSENTIMENTO }],
    ['sem resposta explícita', { versao: VERSAO_TERMO_CONSENTIMENTO }],
    ['"sim" em texto não vale como aceite', { aceito: 'true', versao: VERSAO_TERMO_CONSENTIMENTO }],
  ])('consentimento %s é recusado', (_rotulo, consentimento) => {
    expect(() => Paciente.garantirConsentimento(consentimento)).toThrow(
      expect.objectContaining({ codigo: 'CONSENTIMENTO_OBRIGATORIO', acao: 'exibir_termo' })
    );
  });

  test('aceite de versão antiga do termo é recusado', () => {
    expect(() =>
      Paciente.garantirConsentimento({ aceito: true, versao: '2020-01-v0' })
    ).toThrow(expect.objectContaining({ message: expect.stringMatching(/atualizado/) }));
  });
});

describe('CadastrarPaciente', () => {
  test('cadastra com a versão do termo e o horário do servidor', async () => {
    const { cadastrar } = montar();

    const paciente = await cadastrar.executar({
      identidade: IDENTIDADE_A,
      nome: 'Maria da Silva',
      consentimento: ACEITE,
    });

    expect(paciente.firebaseUid).toBe('uid-a');
    expect(paciente.consentimentoVersao).toBe(VERSAO_TERMO_CONSENTIMENTO);
    // O instante vem do relógio injetado, nunca de um campo enviado pelo app.
    expect(paciente.consentimentoEm.getTime()).toBe(AGORA.getTime());
  });

  test('o horário do consentimento enviado pelo cliente é ignorado', async () => {
    const { cadastrar } = montar();

    const paciente = await cadastrar.executar({
      identidade: IDENTIDADE_A,
      nome: 'Maria da Silva',
      consentimento: { ...ACEITE, em: '1999-01-01T00:00:00Z' },
    });

    expect(paciente.consentimentoEm.getTime()).toBe(AGORA.getTime());
  });

  test('o e-mail vem da identidade verificada, não do corpo', async () => {
    const { cadastrar } = montar();

    const paciente = await cadastrar.executar({
      identidade: IDENTIDADE_A,
      nome: 'Maria da Silva',
      email: 'outra.pessoa@example.com',
      consentimento: ACEITE,
    });

    expect(paciente.email).toBe('paciente.a@example.com');
  });

  test('sem consentimento, nada é gravado', async () => {
    const { cadastrar, pacientes } = montar();

    await expect(
      cadastrar.executar({ identidade: IDENTIDADE_A, nome: 'Maria da Silva' })
    ).rejects.toMatchObject({ codigo: 'CONSENTIMENTO_OBRIGATORIO', status: 422 });

    expect(await pacientes.porFirebaseUid('uid-a')).toBeNull();
    expect(pacientes.auditoria).toEqual([]);
  });

  test('a mesma conta não se cadastra duas vezes', async () => {
    const { cadastrar } = montar();
    await cadastrar.executar({ identidade: IDENTIDADE_A, nome: 'Maria', consentimento: ACEITE });

    await expect(
      cadastrar.executar({ identidade: IDENTIDADE_A, nome: 'Maria', consentimento: ACEITE })
    ).rejects.toMatchObject({ codigo: 'PACIENTE_JA_CADASTRADO', status: 409 });
  });

  test('conta sem e-mail não pode se cadastrar', async () => {
    const { cadastrar } = montar();

    await expect(
      cadastrar.executar({ identidade: { uid: 'uid-x', email: null }, nome: 'Sem E-mail', consentimento: ACEITE })
    ).rejects.toMatchObject({ codigo: 'CONTA_SEM_EMAIL', status: 422 });
  });

  test('o cadastro fica registrado na auditoria, sem dados pessoais', async () => {
    const { cadastrar, pacientes } = montar();

    await cadastrar.executar({
      identidade: IDENTIDADE_A,
      nome: 'Maria da Silva',
      telefone: '88999998888',
      consentimento: ACEITE,
    });

    expect(pacientes.auditoria).toHaveLength(1);
    const registro = JSON.stringify(pacientes.auditoria[0]);
    expect(registro).not.toMatch(/Maria|88999998888|example\.com/);
  });
});

describe('AtualizarPerfil', () => {
  async function comDoisPacientes() {
    const montado = montar();
    const a = await montado.cadastrar.executar({ identidade: IDENTIDADE_A, nome: 'Ana', consentimento: ACEITE });
    const b = await montado.cadastrar.executar({ identidade: IDENTIDADE_B, nome: 'Bruno', consentimento: ACEITE });
    return { ...montado, a, b };
  }

  test('altera nome, telefone e data de nascimento', async () => {
    const { atualizar, a } = await comDoisPacientes();

    const depois = await atualizar.executar({
      pacienteId: a.id,
      alteracoes: { nome: 'Ana Paula', telefone: '88988887777', dataNascimento: '1990-05-17' },
    });

    expect(depois).toMatchObject({
      nome: 'Ana Paula',
      telefone: '88988887777',
      dataNascimento: '1990-05-17',
    });
  });

  test('não altera e-mail nem consentimento, mesmo se vierem', async () => {
    const { atualizar, a } = await comDoisPacientes();

    const depois = await atualizar.executar({
      pacienteId: a.id,
      alteracoes: {
        nome: 'Ana Paula',
        email: 'invasor@example.com',
        consentimentoVersao: 'forjada',
        firebaseUid: 'uid-b',
      },
    });

    expect(depois.email).toBe('paciente.a@example.com');
    expect(depois.consentimentoVersao).toBe(VERSAO_TERMO_CONSENTIMENTO);
    expect(depois.firebaseUid).toBe('uid-a');
  });

  test('alterar A não mexe em B', async () => {
    const { atualizar, pacientes, a, b } = await comDoisPacientes();

    await atualizar.executar({ pacienteId: a.id, alteracoes: { nome: 'Ana Paula' } });

    expect((await pacientes.porId(b.id)).nome).toBe('Bruno');
  });

  test('pedido sem nenhum campo permitido é recusado', async () => {
    const { atualizar, a } = await comDoisPacientes();

    await expect(
      atualizar.executar({ pacienteId: a.id, alteracoes: { email: 'x@example.com' } })
    ).rejects.toMatchObject({ codigo: 'NADA_A_ATUALIZAR', status: 422 });
  });

  test('a auditoria guarda os nomes dos campos, não os valores', async () => {
    const { atualizar, pacientes, a } = await comDoisPacientes();

    await atualizar.executar({ pacienteId: a.id, alteracoes: { telefone: '88977776666' } });

    const ultimo = pacientes.auditoria.at(-1);
    expect(ultimo.detalhe).toEqual({ campos: ['telefone'] });
    expect(JSON.stringify(ultimo)).not.toMatch(/88977776666/);
  });
});
