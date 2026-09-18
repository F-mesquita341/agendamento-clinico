'use strict';

/**
 * O avaliador do teste de carga precisa ACUSAR falha quando ela existe.
 *
 * O sistema real não consegue produzir agendamento duplicado sem desmontar três
 * defesas ao mesmo tempo — o status no UPDATE, a versão e o índice único
 * parcial —, então não há como confirmar o detector reintroduzindo um defeito
 * no código. A confirmação é esta: entradas sintéticas, cada uma com uma falha
 * diferente, e o avaliador precisa reprovar todas.
 */

const {
  percentil,
  resumir,
  avaliarRodadaHttp,
  avaliarRodadaAdaptador,
} = require('../carga/avaliacao');

const N = 100;
const PRECO = 25000;

/** Uma rodada HTTP correta; cada teste estraga uma parte. */
function rodadaHttpCorreta() {
  return {
    n: N,
    precoEsperado: PRECO,
    respostas: [
      { status: 201, codigo: null },
      ...Array.from({ length: N - 1 }, () => ({ status: 409, codigo: 'HORARIO_INDISPONIVEL' })),
    ],
    banco: {
      consultasAtivas: 1,
      versao: 1,
      status: 'reservado',
      auditorias: 1,
      valorCentavos: PRECO,
    },
  };
}

function rodadaAdaptadorCorreta() {
  return {
    n: N,
    resultados: [
      { tipo: 'consulta' },
      ...Array.from({ length: N - 1 }, () => ({ tipo: 'nulo' })),
    ],
    banco: { consultasAtivas: 1, versao: 1 },
  };
}

describe('percentil (posto mais próximo)', () => {
  const umACem = Array.from({ length: 100 }, (_, i) => i + 1);

  test('p50, p95 e p100 de 1..100', () => {
    expect(percentil(umACem, 50)).toBe(50);
    expect(percentil(umACem, 95)).toBe(95);
    expect(percentil(umACem, 100)).toBe(100);
  });

  test('não depende da ordem de entrada e não a altera', () => {
    const embaralhado = [30, 10, 20];
    expect(percentil(embaralhado, 50)).toBe(20);
    expect(embaralhado).toEqual([30, 10, 20]);
  });

  test('lista vazia não tem percentil', () => {
    expect(percentil([], 50)).toBeNull();
  });
});

describe('resumir', () => {
  test('mínimo, p50, p95 e máximo', () => {
    const umACem = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(resumir(umACem)).toEqual({ minimo: 1, p50: 50, p95: 95, maximo: 100 });
  });
});

describe('avaliarRodadaHttp', () => {
  test('a rodada correta é aprovada, sem falhas', () => {
    expect(avaliarRodadaHttp(rodadaHttpCorreta())).toEqual({
      aprovada: true,
      conflitos: 0,
      falhas: [],
    });
  });

  test('dois 201 reprovam', () => {
    const rodada = rodadaHttpCorreta();
    rodada.respostas[1] = { status: 201, codigo: null };

    const resultado = avaliarRodadaHttp(rodada);

    expect(resultado.aprovada).toBe(false);
    expect(resultado.falhas.join(' ')).toMatch(/2 agendamentos/);
  });

  test('duas consultas ativas no banco reprovam, e contam como conflito', () => {
    // O caso mais grave: a API responde certo e o banco guarda errado. É isso
    // que a Seção 4.5 chama de conflito.
    const rodada = rodadaHttpCorreta();
    rodada.banco.consultasAtivas = 2;

    const resultado = avaliarRodadaHttp(rodada);

    expect(resultado.aprovada).toBe(false);
    expect(resultado.conflitos).toBe(1);
    expect(resultado.falhas.join(' ')).toMatch(/duplicad/);
  });

  test.each([
    ['um 500 no meio', { status: 500, codigo: 'ERRO_INTERNO' }, /500/],
    ['um 422 no meio', { status: 422, codigo: 'CONSULTA_SOBREPOSTA' }, /422/],
    ['um 409 com outro código', { status: 409, codigo: 'OUTRA_COISA' }, /OUTRA_COISA/],
  ])('%s reprova', (_rotulo, intrusa, mensagem) => {
    const rodada = rodadaHttpCorreta();
    rodada.respostas[50] = intrusa;

    const resultado = avaliarRodadaHttp(rodada);

    expect(resultado.aprovada).toBe(false);
    expect(resultado.falhas.join(' ')).toMatch(mensagem);
  });

  test('nenhum 201 reprova — ninguém conseguiu agendar', () => {
    const rodada = rodadaHttpCorreta();
    rodada.respostas[0] = { status: 409, codigo: 'HORARIO_INDISPONIVEL' };
    rodada.banco.consultasAtivas = 0;

    expect(avaliarRodadaHttp(rodada).aprovada).toBe(false);
  });

  test('resposta faltando reprova', () => {
    const rodada = rodadaHttpCorreta();
    rodada.respostas.pop();

    const resultado = avaliarRodadaHttp(rodada);

    expect(resultado.aprovada).toBe(false);
    expect(resultado.falhas.join(' ')).toMatch(/99 respostas/);
  });

  test.each([
    ['versão diferente de 1', { versao: 2 }, /versão/],
    ['horário não reservado', { status: 'disponivel' }, /status/],
    ['auditoria duplicada', { auditorias: 2 }, /auditoria/],
    ['valor diferente do preço', { valorCentavos: 0 }, /valor/],
  ])('%s no banco reprova', (_rotulo, estrago, mensagem) => {
    const rodada = rodadaHttpCorreta();
    Object.assign(rodada.banco, estrago);

    const resultado = avaliarRodadaHttp(rodada);

    expect(resultado.aprovada).toBe(false);
    expect(resultado.falhas.join(' ')).toMatch(mensagem);
  });
});

describe('avaliarRodadaAdaptador', () => {
  test('a rodada correta é aprovada', () => {
    expect(avaliarRodadaAdaptador(rodadaAdaptadorCorreta())).toEqual({
      aprovada: true,
      conflitos: 0,
      falhas: [],
    });
  });

  test('duas consultas criadas reprovam', () => {
    const rodada = rodadaAdaptadorCorreta();
    rodada.resultados[1] = { tipo: 'consulta' };
    rodada.banco.consultasAtivas = 2;

    const resultado = avaliarRodadaAdaptador(rodada);

    expect(resultado.aprovada).toBe(false);
    expect(resultado.conflitos).toBe(1);
  });

  test('uma exceção reprova, com a mensagem dela', () => {
    const rodada = rodadaAdaptadorCorreta();
    rodada.resultados[7] = { tipo: 'erro', erro: 'deadlock detected' };

    const resultado = avaliarRodadaAdaptador(rodada);

    expect(resultado.aprovada).toBe(false);
    expect(resultado.falhas.join(' ')).toMatch(/deadlock detected/);
  });

  test('versão diferente de 1 reprova', () => {
    const rodada = rodadaAdaptadorCorreta();
    rodada.banco.versao = 3;

    expect(avaliarRodadaAdaptador(rodada).aprovada).toBe(false);
  });
});
