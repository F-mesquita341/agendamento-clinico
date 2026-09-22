'use strict';

/**
 * Verificação do ID Token emitido pelo Firebase Authentication.
 *
 * Contrato do verificador, o mesmo que os testes simulam:
 *   recebe o token (texto)
 *   devolve { uid, email } se o token for válido
 *   lança SessaoExpirada se o token expirou
 *   lança NaoAutenticado se o token for inválido
 *   deixa passar qualquer outro erro — problema do servidor, não do cliente
 *
 * Essa última regra importa. Credencial ausente, arquivo de chave corrompido ou
 * falha de rede ao buscar as chaves públicas do Google não são culpa de quem
 * fez a requisição. Traduzi-los em 401 mandaria a pessoa refazer login num
 * sistema que está quebrado do lado de cá, e esconderia a falha do
 * monitoramento. Por isso a tradução usa uma lista fechada de códigos.
 *
 * Carregamento: o servidor chama `preparar()` na subida, para que o SDK — que
 * são centenas de arquivos — seja carregado antes da primeira requisição, e não
 * durante ela. Carregá-lo sob demanda fazia a primeira pessoa autenticada
 * esperar, e sob `node --watch` no Windows chegou a derrubar a conexão: a
 * leitura inicial desses arquivos foi tomada por mudança e reiniciou a API no
 * meio da resposta.
 *
 * Sem `preparar()`, o carregamento continua sob demanda. A suíte de testes
 * injeta um verificador falso e nunca chega aqui — o que permite rodá-la sem
 * rede e sem credencial, inclusive na integração contínua.
 */

const { NaoAutenticado, SessaoExpirada } = require('../../domain/erros');
const { obterAppDoFirebase } = require('./app');

/** Códigos do Firebase que significam "o token enviado não serve". */
const TOKEN_INVALIDO = new Set([
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/id-token-revoked',
  'auth/user-disabled',
]);

/**
 * @param {object} [opcoes]
 * @param {{verifyIdToken: Function}} [opcoes.auth] instância do Firebase Auth;
 *        informada apenas nos testes do próprio adaptador.
 */
function criarVerificadorFirebase({ auth } = {}) {
  let autenticador = auth ?? null;

  function obterAutenticador() {
    if (!autenticador) {
      const { getAuth } = require('firebase-admin/auth');
      autenticador = getAuth(obterAppDoFirebase());
    }
    return autenticador;
  }

  async function verificarToken(token) {
    let decodificado;
    try {
      // checkRevoked = false: verificar revogação exigiria uma chamada aos
      // servidores do Firebase a cada requisição. A troca está registrada no
      // diário; tokens expiram em uma hora de qualquer forma.
      decodificado = await obterAutenticador().verifyIdToken(token, false);
    } catch (erro) {
      if (erro?.code === 'auth/id-token-expired') {
        throw new SessaoExpirada();
      }
      if (TOKEN_INVALIDO.has(erro?.code)) {
        throw new NaoAutenticado('Sua sessão é inválida. Entre novamente para continuar.');
      }
      throw erro;
    }

    return { uid: decodificado.uid, email: decodificado.email ?? null };
  }

  /**
   * Carrega o SDK e inicializa o app imediatamente. Idempotente: chamadas
   * seguintes reaproveitam a instância já criada.
   */
  verificarToken.preparar = () => {
    obterAutenticador();
  };

  return verificarToken;
}

module.exports = { criarVerificadorFirebase };
