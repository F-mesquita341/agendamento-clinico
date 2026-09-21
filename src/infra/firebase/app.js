'use strict';

/**
 * O app do Firebase Admin, um só para toda a API.
 *
 * Dois adaptadores precisam dele — a verificação de token e o envio de
 * notificação — e os dois usam a MESMA conta de serviço. Inicializar duas vezes
 * estouraria no SDK; cada um chamando `getApps()[0] ?? initializeApp(...)` por
 * conta própria funcionaria, mas duplicaria a leitura da credencial e o
 * tratamento do "\n" literal, que é o tipo de detalhe que se corrige num lugar
 * e se esquece no outro.
 *
 * O carregamento é tardio de propósito: o SDK são centenas de arquivos, e a
 * suíte de testes — que injeta dublês e nunca chega aqui — roda sem rede e sem
 * credencial, inclusive na integração contínua.
 */

const config = require('../../config');

let app = null;

function credencialDoFirebase() {
  const { applicationDefault, cert } = require('firebase-admin/app');

  if (config.credencialFirebase === 'campos') {
    return cert({
      projectId: config.FIREBASE_PROJECT_ID,
      clientEmail: config.FIREBASE_CLIENT_EMAIL,
      // Painéis de variáveis costumam guardar a chave com "\n" literal em vez
      // de quebra de linha real; sem a conversão, a chave não é reconhecida.
      privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  }
  // Lê o arquivo apontado por GOOGLE_APPLICATION_CREDENTIALS.
  return applicationDefault();
}

/** Idempotente: a segunda chamada devolve a instância já criada. */
function obterAppDoFirebase() {
  if (!app) {
    const { initializeApp, getApps } = require('firebase-admin/app');
    app = getApps()[0] ?? initializeApp({ credential: credencialDoFirebase() });
  }
  return app;
}

module.exports = { obterAppDoFirebase };
