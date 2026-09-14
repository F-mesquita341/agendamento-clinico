'use strict';

/**
 * Configuração da aplicação.
 *
 * Lê e VALIDA as variáveis de ambiente no momento da subida. Se faltar algo,
 * o processo morre aqui, com mensagem legível — em vez de quebrar mais tarde,
 * no meio de uma requisição, com um erro obscuro de conexão.
 */

require('dotenv').config();
const { z } = require('zod');

const esquema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORTA: z.coerce.number().int().positive().default(3000),

  // Ambas opcionais no esquema; a exigência real depende do NODE_ENV e é
  // verificada logo abaixo, com mensagem específica para cada caso.
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_TESTE: z.string().min(1).optional(),

  ORIGENS_PERMITIDAS: z.string().default('*'),

  RESERVA_MINUTOS: z.coerce.number().int().positive().default(15),

  // 'tcp' fala com o PostgreSQL na 5432, como de costume. 'websocket' usa o
  // driver do Neon na 443, para redes que bloqueiam a porta do banco.
  // Ver src/infra/db/driver.js.
  TRANSPORTE_BANCO: z.enum(['tcp', 'websocket']).default('tcp'),
});

const resultado = esquema.safeParse(process.env);

if (!resultado.success) {
  const linhas = resultado.error.issues.map(
    (i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`
  );
  console.error(
    [
      '',
      'Configuração inválida. A API não vai subir.',
      '',
      ...linhas,
      '',
      'Copie .env.example para .env e preencha os valores.',
      '',
    ].join('\n')
  );
  process.exit(1);
}

const config = resultado.data;

function abortar(mensagem) {
  console.error(`\n${mensagem}\n`);
  process.exit(1);
}

/**
 * Reduz uma string de conexão ao par host+banco que ela realmente alcança.
 *
 * Comparar as duas URLs como texto não basta: o Neon expõe o MESMO banco por
 * dois hostnames — o direto e o terminado em "-pooler". Duas strings
 * diferentes podendo apagar o mesmo banco é exatamente o acidente que a
 * verificação abaixo existe para evitar.
 */
function bancoAlcancado(url) {
  try {
    const endereco = new URL(url);
    const host = endereco.hostname.replace(/-pooler(?=\.)/, '');
    return `${host}${endereco.pathname}`;
  } catch {
    return url;
  }
}

if (config.NODE_ENV === 'test') {
  // A suíte apaga tabelas. Rodar contra o banco de desenvolvimento por engano
  // custa horas de trabalho perdido.
  if (!config.DATABASE_URL_TESTE) {
    abortar(
      'NODE_ENV=test exige DATABASE_URL_TESTE definida — a suíte limpa tabelas.'
    );
  }
  // Só compara quando as duas existem. Na integração contínua o banco é
  // efêmero e descartado a cada execução, então lá só DATABASE_URL_TESTE
  // é definida e não há o que confundir.
  if (
    config.DATABASE_URL &&
    bancoAlcancado(config.DATABASE_URL) ===
      bancoAlcancado(config.DATABASE_URL_TESTE)
  ) {
    abortar(
      'DATABASE_URL_TESTE alcança o MESMO banco que DATABASE_URL.\n' +
        'A suíte de testes apaga tabelas — isso destruiria seus dados de\n' +
        'desenvolvimento.\n\n' +
        'Crie um segundo banco no painel do Neon (ex.: agendamento_teste) e\n' +
        'troque o nome do banco no final de DATABASE_URL_TESTE.\n\n' +
        'Atenção: trocar o host direto pelo "-pooler" NÃO cria um banco\n' +
        'diferente — os dois hostnames alcançam o mesmo lugar.'
    );
  }
  config.urlDoBanco = config.DATABASE_URL_TESTE;
} else {
  if (!config.DATABASE_URL) {
    abortar(
      'DATABASE_URL não definida. Copie .env.example para .env e preencha a\n' +
        'string de conexão do Neon.'
    );
  }
  config.urlDoBanco = config.DATABASE_URL;
}

config.origens =
  config.ORIGENS_PERMITIDAS === '*'
    ? '*'
    : config.ORIGENS_PERMITIDAS.split(',').map((o) => o.trim()).filter(Boolean);

module.exports = config;
