'use strict';

/**
 * Verificador de token para os testes — sem rede, sem credencial.
 *
 * Cumpre o mesmo contrato do verificador real em
 * src/infra/firebase/verificadorDeToken.js: devolve `{ uid, email }` ou lança
 * `SessaoExpirada` / `NaoAutenticado`. Os testes de integração exercitam toda a
 * API autenticada com ele; o token real do Firebase é provado à parte, por
 * scripts/verificar-token-real.js.
 *
 * Tokens aceitos:
 *   tokenDe('uid-a', 'a@example.com')  → identidade { uid: 'uid-a', email: 'a@example.com' }
 *   TOKEN_EXPIRADO                     → SessaoExpirada
 *   qualquer outro texto               → NaoAutenticado
 */

const { NaoAutenticado, SessaoExpirada } = require('../../src/domain/erros');

const TOKEN_EXPIRADO = 'teste-token-expirado';

function tokenDe(uid, email) {
  return `teste:${uid}:${email}`;
}

async function verificadorFalso(token) {
  if (token === TOKEN_EXPIRADO) {
    throw new SessaoExpirada();
  }
  const partes = /^teste:([^:]+):(.+)$/.exec(token);
  if (!partes) {
    throw new NaoAutenticado('Sua sessão é inválida. Entre novamente para continuar.');
  }
  return { uid: partes[1], email: partes[2] };
}

module.exports = { verificadorFalso, tokenDe, TOKEN_EXPIRADO };
