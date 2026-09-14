'use strict';

/**
 * O tempo como dependência, não como efeito colateral.
 *
 * Regras do domínio dependem do instante presente — "não agendar no passado",
 * "a reserva expirou". Se elas chamassem `new Date()` diretamente, testá-las
 * exigiria esperar o relógio andar ou congelar o tempo globalmente.
 *
 * Injetando um relógio, o teste diz exatamente que horas são.
 */

const relogioDoSistema = Object.freeze({
  agora: () => new Date(),
});

/** Relógio parado em um instante, para os testes. */
function relogioFixo(instante) {
  const congelado = instante instanceof Date ? instante : new Date(instante);
  return Object.freeze({
    agora: () => new Date(congelado),
  });
}

module.exports = { relogioDoSistema, relogioFixo };
