'use strict';

/**
 * Escolhe o serviço de notificação a partir da configuração — espelha
 * ../pagamento/index.js.
 *
 * Com credencial do Firebase, o FCM de verdade; sem ela, um serviço que não
 * envia nada e diz isso no log, o que deixa a API subir em desenvolvimento sem
 * credencial. Em produção, config.js já recusou a subida sem ela.
 */

const config = require('../../config');
const { ServicoFcm, ServicoNaoConfigurado } = require('./ServicoFcm');

function criarServicoDeNotificacao() {
  if (!config.credencialFirebase) {
    return new ServicoNaoConfigurado();
  }
  return new ServicoFcm();
}

module.exports = { criarServicoDeNotificacao };
