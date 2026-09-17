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

/**
 * Objeto que recusa campos não previstos.
 *
 * Usado nos corpos que tocam dado pessoal: se o aplicativo mandar `email` ou
 * `firebaseUid` achando que serão aplicados, é melhor recusar com mensagem
 * clara do que ignorar em silêncio e deixar o defeito do cliente passar.
 */
function objetoEstrito(forma, descricao) {
  return z
    .object(forma, {
      errorMap: (problema, contexto) => {
        if (problema.code === 'unrecognized_keys') {
          return { message: `Campo não permitido: ${problema.keys.join(', ')}.` };
        }
        if (problema.code === 'invalid_type') {
          return { message: `${descricao} precisa ser um objeto JSON.` };
        }
        return { message: contexto.defaultError };
      },
    })
    .strict();
}

/** Nome da pessoa: espaços extras removidos, de 2 a 120 caracteres. */
function nomeDePessoa() {
  return z
    .string({
      required_error: 'Informe o nome.',
      invalid_type_error: 'O nome precisa ser um texto.',
    })
    .transform((texto) => texto.trim().replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .min(2, 'O nome precisa ter ao menos duas letras.')
        .max(120, 'O nome é longo demais.')
    );
}

/** Telefone brasileiro com DDD, guardado só com os dígitos. */
function telefone() {
  return z
    .string({ invalid_type_error: 'O telefone precisa ser um texto.' })
    .transform((texto) => texto.replace(/\D/g, ''))
    .refine((digitos) => digitos.length === 10 || digitos.length === 11, {
      message: 'Informe o telefone com DDD, com 10 ou 11 dígitos.',
    });
}

/**
 * Fuso civil da clínica parceira, em Quixadá (CE) — o mesmo usado no seed.
 * Sem horário de verão desde 2019.
 */
const FUSO_DA_CLINICA = 'America/Fortaleza';

/**
 * Data de calendário (AAAA-MM-DD) de um instante, no fuso informado.
 *
 * `toISOString()` daria a data em UTC. No Brasil, entre 21h e meia-noite, o UTC
 * já está no dia seguinte — e "hoje" viraria amanhã, deixando passar como data
 * de nascimento uma data que ainda não chegou. O servidor de hospedagem, além
 * disso, costuma rodar em UTC, longe do fuso de quem usa o aplicativo.
 */
function dataCivil(instante, fuso = FUSO_DA_CLINICA) {
  // O formato en-CA já é AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instante);
}

/**
 * Data de calendário no formato AAAA-MM-DD, sem hora e sem fuso.
 *
 * Confere que a data existe de fato — "2026-02-30" tem o formato certo e não
 * é um dia — e que não está no futuro.
 */
function dataDeNascimento() {
  const hoje = () => dataCivil(new Date());
  const existe = (texto) => {
    const instante = new Date(`${texto}T00:00:00Z`);
    return !Number.isNaN(instante.getTime()) && instante.toISOString().slice(0, 10) === texto;
  };

  // Verificações em sequência, parando na primeira falha. Com refinamentos
  // independentes, um texto como "abc" acumularia três mensagens — e uma delas
  // diria que a data "está no futuro", porque "abc" > "2026-..." na comparação
  // de texto. O paciente veria um erro que não descreve o que fez.
  return z
    .string({ invalid_type_error: 'A data de nascimento precisa ser um texto.' })
    .superRefine((texto, contexto) => {
      const falhar = (message) => contexto.addIssue({ code: z.ZodIssueCode.custom, message });

      if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
        return falhar('Informe a data de nascimento no formato AAAA-MM-DD.');
      }
      if (!existe(texto)) {
        return falhar('Essa data de nascimento não existe no calendário.');
      }
      if (texto < '1900-01-01') {
        return falhar('Confira o ano da data de nascimento.');
      }
      if (texto > hoje()) {
        return falhar('A data de nascimento não pode estar no futuro.');
      }
    });
}

module.exports = {
  FUSO_DA_CLINICA,
  dataCivil,
  inteiroPositivo,
  data,
  objetoEstrito,
  nomeDePessoa,
  telefone,
  dataDeNascimento,
};
