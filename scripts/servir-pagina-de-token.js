'use strict';

/**
 * Serve a página de prova da Etapa 9 em http://localhost:4000.
 *
 * Um servidor próprio, e não abrir o arquivo do disco, porque service worker
 * exige contexto seguro — e `localhost` conta como seguro, `file://` não.
 *
 * A configuração do app web do Firebase é PÚBLICA por natureza: é feita para
 * ficar embutida em página e aplicativo. Nem por isso ela fica no repositório —
 * ela identifica UM projeto, e quem reproduzir o trabalho usará o seu. Vem do
 * ambiente e é entregue à página como script.
 *
 * Uso, com as variáveis no .env:
 *
 *   npm run pagina:token
 *
 * Variáveis — todas da tela Configurações do projeto do console do Firebase:
 *
 *   FIREBASE_WEB_API_KEY     Geral → Seus apps → app Web → apiKey
 *   FIREBASE_WEB_APP_ID      Geral → Seus apps → app Web → appId
 *   FIREBASE_WEB_SENDER_ID   Geral → Seus apps → app Web → messagingSenderId
 *   FIREBASE_WEB_VAPID_KEY   Cloud Messaging → Certificados push da Web
 *
 * O id do projeto vem de FIREBASE_PROJECT_ID ou, na falta, do arquivo de
 * credencial apontado por GOOGLE_APPLICATION_CREDENTIALS — só o campo
 * `project_id`, nada mais é lido dele.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORTA = Number(process.env.PORTA_PAGINA ?? 4000);
const PASTA = path.join(__dirname, 'pagina-de-token');
const API_PADRAO = process.env.API_URL ?? 'https://agendamento-clinico-api.onrender.com';

function idDoProjeto() {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  const caminho = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!caminho) return null;
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8')).project_id ?? null;
  } catch {
    return null;
  }
}

const projectId = idDoProjeto();
const faltando = [
  ['FIREBASE_WEB_API_KEY', process.env.FIREBASE_WEB_API_KEY],
  ['FIREBASE_WEB_APP_ID', process.env.FIREBASE_WEB_APP_ID],
  ['FIREBASE_WEB_SENDER_ID', process.env.FIREBASE_WEB_SENDER_ID],
  ['FIREBASE_WEB_VAPID_KEY', process.env.FIREBASE_WEB_VAPID_KEY],
  ['FIREBASE_PROJECT_ID (ou GOOGLE_APPLICATION_CREDENTIALS)', projectId],
]
  .filter(([, valor]) => !valor)
  .map(([nome]) => nome);

if (faltando.length) {
  console.error(
    `\nFaltam no .env: ${faltando.join(', ')}.\n` +
      'Veja no topo de scripts/servir-pagina-de-token.js onde achar cada uma.\n'
  );
  process.exitCode = 1;
  return;
}

const configuracao = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: `${projectId}.firebaseapp.com`,
  projectId,
  messagingSenderId: process.env.FIREBASE_WEB_SENDER_ID,
  appId: process.env.FIREBASE_WEB_APP_ID,
};

const ARQUIVOS = {
  '/': { arquivo: 'index.html', tipo: 'text/html; charset=utf-8' },
  '/index.html': { arquivo: 'index.html', tipo: 'text/html; charset=utf-8' },
  '/firebase-messaging-sw.js': { arquivo: 'firebase-messaging-sw.js', tipo: 'text/javascript' },
};

const GERADOS = {
  '/config.js': () =>
    `window.FIREBASE_CONFIG = ${JSON.stringify(configuracao)};\n` +
    `window.VAPID_KEY = ${JSON.stringify(process.env.FIREBASE_WEB_VAPID_KEY)};\n` +
    `window.API_PADRAO = ${JSON.stringify(API_PADRAO)};\n`,
  '/config-sw.js': () => `self.FIREBASE_CONFIG = ${JSON.stringify(configuracao)};\n`,
};

const servidor = http.createServer((req, res) => {
  const caminho = new URL(req.url, 'http://localhost').pathname;

  if (GERADOS[caminho]) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(GERADOS[caminho]());
    return;
  }

  const alvo = ARQUIVOS[caminho];
  if (!alvo) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado.');
    return;
  }
  res.writeHead(200, { 'Content-Type': alvo.tipo, 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(PASTA, alvo.arquivo)).pipe(res);
});

// Só na interface local: esta página não tem por que ser alcançada de fora.
servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`\nPágina de prova em http://localhost:${PORTA}`);
  console.log(`API padrão: ${API_PADRAO}`);
  console.log('Ctrl+C para encerrar.\n');
});
