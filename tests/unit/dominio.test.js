'use strict';

const { Dinheiro } = require('../../src/domain/Dinheiro');
const { Horario } = require('../../src/domain/Horario');
const { Consulta } = require('../../src/domain/Consulta');

describe('Dinheiro', () => {
  test('guarda centavos e formata no padrão brasileiro', () => {
    expect(Dinheiro.deCentavos(15000).formatar()).toBe('R$ 150,00');
    expect(Dinheiro.deCentavos(5).formatar()).toBe('R$ 0,05');
    expect(Dinheiro.deCentavos(125000).formatar()).toBe('R$ 1.250,00');
  });

  test('não aceita valor negativo nem fracionário em centavos', () => {
    expect(() => Dinheiro.deCentavos(-1)).toThrow(/negativo/i);
    expect(() => Dinheiro.deCentavos(10.5)).toThrow(/inteiro/i);
  });

  test('evita o erro de ponto flutuante que dinheiro em float produz', () => {
    // 0.1 + 0.2 === 0.30000000000000004 em IEEE 754.
    const soma = Dinheiro.deReais(0.1).somar(Dinheiro.deReais(0.2));
    expect(soma.centavos).toBe(30);
    expect(soma.igualA(Dinheiro.deReais(0.3))).toBe(true);
  });

  test('é imutável: somar devolve instância nova', () => {
    const original = Dinheiro.deCentavos(1000);
    const somado = original.somar(Dinheiro.deCentavos(500));

    expect(original.centavos).toBe(1000);
    expect(somado.centavos).toBe(1500);
  });
});

describe('Horario', () => {
  const inicio = new Date('2026-10-05T14:00:00-03:00');
  const fim = new Date('2026-10-05T14:30:00-03:00');

  function criar(extras = {}) {
    return new Horario({ id: 1, profissionalId: 10, inicio, fim, ...extras });
  }

  test('recusa intervalo em que o fim não é posterior ao início', () => {
    expect(() => new Horario({ id: 1, profissionalId: 10, inicio, fim: inicio })).toThrow(
      /posterior/i
    );
  });

  test('calcula a própria duração', () => {
    expect(criar().duracaoEmMinutos()).toBe(30);
  });

  test('sabe a quem pertence', () => {
    expect(criar().pertenceAo(10)).toBe(true);
    expect(criar().pertenceAo('10')).toBe(true); // id vindo do banco como texto
    expect(criar().pertenceAo(99)).toBe(false);
  });

  test('horário já reservado recusa nova reserva com 409', () => {
    const antes = new Date('2026-10-05T10:00:00-03:00');

    expect(() => criar({ status: 'reservado' }).garantirQuePodeSerReservado(antes)).toThrow(
      expect.objectContaining({ status: 409 })
    );
  });

  test('horário que já começou recusa reserva com 422', () => {
    const depois = new Date('2026-10-05T14:01:00-03:00');

    expect(() => criar().garantirQuePodeSerReservado(depois)).toThrow(
      expect.objectContaining({ codigo: 'HORARIO_NO_PASSADO' })
    );
  });
});

describe('Consulta', () => {
  const base = { id: 1, pacienteId: 7, horarioId: 1, valor: 15000 };

  test('só cancelada deixa de ocupar o horário', () => {
    expect(new Consulta({ ...base, status: 'confirmada' }).estaAtiva()).toBe(true);
    expect(new Consulta({ ...base, status: 'nao_compareceu' }).estaAtiva()).toBe(true);
    expect(new Consulta({ ...base, status: 'cancelada' }).estaAtiva()).toBe(false);
  });

  test('reserva não paga expira no prazo', () => {
    const expiraEm = new Date('2026-10-05T12:15:00-03:00');
    const consulta = new Consulta({ ...base, reservaExpiraEm: expiraEm });

    expect(consulta.expirouAguardandoPagamento(new Date('2026-10-05T12:14:00-03:00'))).toBe(false);
    expect(consulta.expirouAguardandoPagamento(new Date('2026-10-05T12:16:00-03:00'))).toBe(true);
  });

  test('consulta já paga não expira', () => {
    const consulta = new Consulta({
      ...base,
      status: 'confirmada',
      reservaExpiraEm: new Date('2026-10-05T12:15:00-03:00'),
    });

    expect(consulta.expirouAguardandoPagamento(new Date('2026-10-06T00:00:00-03:00'))).toBe(false);
  });

  test('cancelar consulta de outro paciente é 403, não 404', () => {
    const consulta = new Consulta({ ...base, status: 'confirmada' });

    expect(() => consulta.garantirQuePodeSerCanceladaPor(99)).toThrow(
      expect.objectContaining({ status: 403 })
    );
  });

  test('consulta já realizada não pode ser cancelada', () => {
    const consulta = new Consulta({ ...base, status: 'realizada' });

    expect(() => consulta.garantirQuePodeSerCanceladaPor(7)).toThrow(
      expect.objectContaining({ codigo: 'CONSULTA_NAO_CANCELAVEL' })
    );
  });

  test('só consulta confirmada e ainda sem aviso precisa de lembrete', () => {
    expect(new Consulta({ ...base, status: 'confirmada' }).precisaDeLembrete()).toBe(true);
    expect(new Consulta({ ...base, status: 'pendente_pagamento' }).precisaDeLembrete()).toBe(false);
    expect(
      new Consulta({
        ...base,
        status: 'confirmada',
        lembreteEnviadoEm: new Date(),
      }).precisaDeLembrete()
    ).toBe(false);
  });
});
