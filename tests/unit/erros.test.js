'use strict';

const {
  ErroDeDominio,
  HorarioIndisponivel,
  NaoEncontrado,
  NaoAutenticado,
  AcessoNegado,
} = require('../../src/domain/erros');

describe('erros do domínio', () => {
  test('HorarioIndisponivel é conflito e instrui o app a recarregar', () => {
    const erro = new HorarioIndisponivel();

    expect(erro).toBeInstanceOf(ErroDeDominio);
    expect(erro.status).toBe(409);
    expect(erro.codigo).toBe('HORARIO_INDISPONIVEL');
    expect(erro.acao).toBe('recarregar_horarios');
  });

  test('a mensagem é escrita para o paciente, não para o desenvolvedor', () => {
    const erro = new HorarioIndisponivel();

    expect(erro.message).not.toMatch(/versao|rowCount|SQL|null/i);
    expect(erro.message.length).toBeGreaterThan(20);
  });

  test('NaoEncontrado nomeia o recurso ausente', () => {
    expect(new NaoEncontrado('Profissional').message).toBe(
      'Profissional não encontrado.'
    );
    expect(new NaoEncontrado('Profissional').status).toBe(404);
  });

  test('falta de token é 401 e acesso a recurso alheio é 403', () => {
    expect(new NaoAutenticado().status).toBe(401);
    expect(new AcessoNegado().status).toBe(403);
  });

  test('todo erro de domínio se declara esperado', () => {
    for (const erro of [
      new HorarioIndisponivel(),
      new NaoEncontrado(),
      new NaoAutenticado(),
      new AcessoNegado(),
    ]) {
      expect(erro.esperado).toBe(true);
    }
  });
});
