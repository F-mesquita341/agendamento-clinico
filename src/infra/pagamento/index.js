'use strict';

/**
 * Escolhe o gateway de pagamento a partir da configuração.
 *
 * Com credencial, o Mercado Pago de verdade (em sandbox); sem ela, um gateway
 * que responde "indisponível" a tudo — o que deixa a API subir em
 * desenvolvimento sem conta no provedor. Em produção, config.js já recusou a
 * subida sem credencial.
 */

const config = require('../../config');
const { GatewayMercadoPago, GatewayNaoConfigurado } = require('./GatewayMercadoPago');

function criarGatewayDePagamento() {
  if (!config.MERCADO_PAGO_ACCESS_TOKEN) {
    return new GatewayNaoConfigurado();
  }
  return new GatewayMercadoPago({
    accessToken: config.MERCADO_PAGO_ACCESS_TOKEN,
    urlDeNotificacao: config.urlPublica ? `${config.urlPublica}/webhooks/mercadopago` : null,
  });
}

module.exports = { criarGatewayDePagamento };
