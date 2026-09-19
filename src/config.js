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

  // Conexões simultâneas com o banco. Sem esta variável: 5 em teste, 10 fora.
  // O teste de carga usa 10, para medir com a mesma concorrência de produção.
  POOL_MAXIMO: z.coerce
    .number({ invalid_type_error: 'precisa ser um número' })
    .int('precisa ser um número inteiro')
    .positive('precisa ser maior que zero')
    .max(50, 'no máximo 50 — o plano gratuito do Neon limita as conexões')
    .optional(),

  // Credencial do Firebase Admin, em uma de duas formas:
  //   arquivo — GOOGLE_APPLICATION_CREDENTIALS com o CAMINHO do JSON da conta
  //             de serviço. Usada no desenvolvimento: a chave fica no arquivo,
  //             fora do repositório, e nunca passa por este processo como texto.
  //   campos  — as três variáveis FIREBASE_*, para serviços como o Render, onde
  //             não há arquivo e as variáveis ficam no painel do provedor.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().min(1).optional(),
  FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),

  // Mercado Pago, só em sandbox: credencial da CONTA DE TESTE vendedora, e a
  // chave secreta que assina os webhooks. Fora de produção são opcionais — sem
  // elas, a rota de pagamento responde 503 e o webhook recusa tudo.
  MERCADO_PAGO_ACCESS_TOKEN: z.string().min(1).optional(),
  MERCADO_PAGO_SEGREDO_WEBHOOK: z.string().min(1).optional(),

  // Endereço público da API, para o Mercado Pago saber aonde mandar o aviso de
  // pagamento. No Render, RENDER_EXTERNAL_URL é definida pela própria
  // plataforma; URL_PUBLICA, se existir, tem prioridade.
  URL_PUBLICA: z.string().url('precisa ser uma URL completa, com https://').optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
});

// Variável definida com valor vazio (`CHAVE=`) conta como não definida. É o
// que acontece com quem copia o .env.example e não preenche os campos
// opcionais — e isso não pode impedir a API de subir.
const ambiente = Object.fromEntries(
  Object.entries(process.env).filter(([, valor]) => valor !== '')
);

const resultado = esquema.safeParse(ambiente);

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

// --- Credencial do Firebase ---------------------------------------------------

const camposFirebase = [
  config.FIREBASE_PROJECT_ID,
  config.FIREBASE_CLIENT_EMAIL,
  config.FIREBASE_PRIVATE_KEY,
];
const quantosCampos = camposFirebase.filter(Boolean).length;

if (quantosCampos > 0 && quantosCampos < 3) {
  abortar(
    'Credencial do Firebase incompleta: defina FIREBASE_PROJECT_ID,\n' +
      'FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY juntas, ou nenhuma delas.'
  );
}

if (config.GOOGLE_APPLICATION_CREDENTIALS && quantosCampos === 3) {
  // As variáveis FIREBASE_* têm prioridade, então o arquivo não será usado — e
  // por isso também não é validado. Validá-lo impediria a subida por causa de
  // um caminho antigo esquecido no painel, justamente durante a migração de
  // uma forma de credencial para a outra.
  console.warn(
    'Aviso: GOOGLE_APPLICATION_CREDENTIALS ignorada — as variáveis FIREBASE_* estão\n' +
      'definidas e têm prioridade. Remova a que não estiver em uso.'
  );
} else if (config.GOOGLE_APPLICATION_CREDENTIALS) {
  // Verificado aqui, na subida. O SDK só lê o arquivo quando vai verificar o
  // primeiro token — um arquivo ausente ou corrompido passaria despercebido até
  // a primeira pessoa tentar entrar.
  const caminho = config.GOOGLE_APPLICATION_CREDENTIALS;
  const fs = require('fs');

  if (!fs.existsSync(caminho)) {
    abortar(`GOOGLE_APPLICATION_CREDENTIALS aponta para um arquivo que não existe:\n  ${caminho}`);
  }

  let chave;
  try {
    chave = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch {
    // A mensagem do JSON.parse não é repassada de propósito: no Node atual ela
    // cita um trecho do texto inválido, que aqui seria um pedaço da chave privada.
    abortar(
      'GOOGLE_APPLICATION_CREDENTIALS aponta para um arquivo que não é um JSON válido:\n' +
        `  ${caminho}\n` +
        'Gere a chave de novo no console do Firebase, em Contas de serviço.'
    );
  }

  const faltando = ['project_id', 'client_email', 'private_key'].filter(
    (campo) => typeof chave?.[campo] !== 'string' || chave[campo] === ''
  );
  if (chave?.type !== 'service_account' || faltando.length > 0) {
    abortar(
      'GOOGLE_APPLICATION_CREDENTIALS não aponta para uma chave de conta de serviço completa:\n' +
        `  ${caminho}\n` +
        (faltando.length ? `Campos ausentes: ${faltando.join(', ')}.\n` : '') +
        'Gere a chave de novo no console do Firebase, em Contas de serviço.'
    );
  }

  config.projetoFirebase = chave.project_id;
}

config.credencialFirebase =
  quantosCampos === 3 ? 'campos' : config.GOOGLE_APPLICATION_CREDENTIALS ? 'arquivo' : null;

if (config.credencialFirebase === 'campos') {
  config.projetoFirebase = config.FIREBASE_PROJECT_ID;
}

// Em produção, sem credencial nenhuma, toda requisição autenticada falharia.
// Melhor não subir do que subir aparentemente saudável.
if (config.NODE_ENV === 'production' && !config.credencialFirebase) {
  abortar(
    'Em produção a credencial do Firebase é obrigatória. Defina as três\n' +
      'variáveis FIREBASE_* ou GOOGLE_APPLICATION_CREDENTIALS.'
  );
}

config.urlPublica = (config.URL_PUBLICA ?? config.RENDER_EXTERNAL_URL ?? '').replace(/\/+$/, '') || null;

// Em produção, pagamento é parte do fluxo principal: sem credencial, toda
// consulta ficaria presa em "aguardando pagamento" até expirar. Sem URL
// pública, o Mercado Pago não teria para onde avisar.
if (config.NODE_ENV === 'production') {
  const faltando = [
    ['MERCADO_PAGO_ACCESS_TOKEN', config.MERCADO_PAGO_ACCESS_TOKEN],
    ['MERCADO_PAGO_SEGREDO_WEBHOOK', config.MERCADO_PAGO_SEGREDO_WEBHOOK],
    ['URL_PUBLICA (ou RENDER_EXTERNAL_URL)', config.urlPublica],
  ]
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome);

  if (faltando.length > 0) {
    abortar(`Em produção o pagamento precisa estar configurado. Faltando: ${faltando.join(', ')}.`);
  }
}

config.origens =
  config.ORIGENS_PERMITIDAS === '*'
    ? '*'
    : config.ORIGENS_PERMITIDAS.split(',').map((o) => o.trim()).filter(Boolean);

module.exports = config;
