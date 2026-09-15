'use strict';

/**
 * Tipos de entrada reaproveitáveis, com mensagens em português.
 *
 * O Zod emite mensagens em inglês por padrão ("Expected number, received nan").
 * Como as mensagens desta API são escritas para o usuário final — e podem ser
 * exibidas direto no aplicativo —, cada regra declara a sua própria, no mesmo
 * tom das mensagens do domínio.
 */

const { z } = require('zod');

/** Inteiro positivo vindo de query ou de parâmetro de rota, sempre texto. */
function inteiroPositivo(nomeAmigavel) {
  return z.coerce
    .number({ invalid_type_error: `${nomeAmigavel} precisa ser um número.` })
    .int(`${nomeAmigavel} precisa ser um número inteiro.`)
    .positive(`${nomeAmigavel} precisa ser maior que zero.`);
}

/**
 * Data em ISO 8601 vinda da query.
 *
 * Usa `errorMap` em vez de `invalid_type_error` porque são dois problemas
 * distintos: um valor que não é data de jeito nenhum, e um texto que parece
 * data mas o `Date` não consegue interpretar — este último o Zod rejeita com
 * "Invalid date", que `invalid_type_error` não intercepta. O `errorMap` cobre
 * os dois com a mesma frase.
 */
function data(nomeAmigavel) {
  const mensagem = `${nomeAmigavel} precisa ser uma data válida, no formato ISO 8601.`;
  return z.coerce.date({ errorMap: () => ({ message: mensagem }) });
}

module.exports = { inteiroPositivo, data };
