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

/**
 * Fuso civil da clínica parceira, em Quixadá (CE). Sem horário de verão desde
 * 2019, então o deslocamento é constante o ano todo.
 *
 * Mora no domínio porque o domínio precisa dele — o texto do lembrete diz "às
 * 14:30" no horário da clínica — e o domínio não pode importar das camadas de
 * borda. `interfaces/http/esquemas.js` importa daqui: uma declaração só, para
 * que mudar de clínica não deixe o lembrete num fuso e a grade em outro.
 */
const FUSO_DA_CLINICA = 'America/Fortaleza';

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

module.exports = { relogioDoSistema, relogioFixo, FUSO_DA_CLINICA };
