/*
 * Service worker do Firebase Cloud Messaging.
 *
 * É ele que mostra a notificação quando a página está em SEGUNDO plano ou
 * fechada — o caso real de um lembrete, que chega quando a pessoa não está
 * olhando. Como a API envia a mensagem com o campo `notification`, o próprio
 * SDK a exibe; basta inicializá-lo aqui.
 *
 * O nome do arquivo e a posição na raiz do site são exigência do SDK: é onde
 * ele procura o service worker por padrão.
 */

/* global importScripts, firebase */

importScripts('https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js');
// Configuração pública do app web, gerada pelo servidor a partir do ambiente.
importScripts('/config-sw.js');

firebase.initializeApp(self.FIREBASE_CONFIG);
firebase.messaging();
