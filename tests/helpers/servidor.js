'use strict';

/**
 * Sobe e derruba um servidor HTTP real para os testes de integração.
 *
 * Passar o `app` direto ao Supertest funciona, mas ele abre um servidor
 * efêmero por requisição e deixa o socket keep-alive pendurado — o Jest
 * então avisa que não conseguiu encerrar. Controlar o ciclo de vida aqui
 * resolve isso de uma vez para todos os arquivos de teste.
 *
 * Uso:
 *
 *   const { iniciar, parar } = require('../helpers/servidor');
 *   let servidor;
 *   beforeAll(async () => { servidor = await iniciar(); });
 *   afterAll(() => parar(servidor));
 *   // ...
 *   await request(servidor).get('/saude');
 */

const { criarApp } = require('../../src/interfaces/http/app');
const { consultar, encerrar } = require('../../src/infra/db/pool');
const { verificadorFalso } = require('./verificadorFalso');

/**
 * Limite de escritas dos testes que não tratam dele. Vários arquivos usam um
 * mesmo paciente para dezenas de escritas em poucos segundos; com o limite de
 * produção, tropeçariam num 429 que não é o assunto deles. Só
 * tests/integration/limiteDeEscritas.test.js passa um valor baixo.
 */
const SEM_LIMITE_NA_PRATICA = 1_000_000;

/**
 * O verificador falso é o padrão: nenhum teste deve depender, por esquecimento,
 * de rede ou credencial do Firebase — a integração contínua não tem nenhuma
 * das duas.
 */
async function iniciar({
  verificarToken = verificadorFalso,
  relogio,
  gateway,
  segredoDoWebhook,
  limiteDeEscritas = SEM_LIMITE_NA_PRATICA,
  janelaDeEscritasMs,
  origens,
} = {}) {
  // Porta 0: o sistema operacional escolhe uma livre. Sem `gateway`, o app usa
  // o padrão — sem credencial no ambiente de teste, um gateway "indisponível".
  const servidor = criarApp({
    verificarToken,
    relogio,
    limiteDeEscritas,
    ...(janelaDeEscritasMs ? { janelaDeEscritasMs } : {}),
    ...(origens ? { origens } : {}),
    ...(gateway ? { gateway } : {}),
    ...(segredoDoWebhook ? { segredoDoWebhook } : {}),
  }).listen(0);

  // O plano gratuito do Neon suspende o compute quando fica ocioso. A primeira
  // consulta depois disso leva vários segundos para acordá-lo, o que estourava
  // o tempo limite de um teste e o fazia falhar sem que houvesse nada errado.
  // Acordar o banco aqui, no setup, faz cada teste medir o que ele pretende
  // medir — e não a hibernação da infraestrutura.
  await consultar('SELECT 1');

  return servidor;
}

/**
 * Fecha só o servidor, mantendo o pool do banco. Para quem precisa de um app
 * novo a cada teste — o limitador guarda a contagem na memória do app.
 */
async function fechar(servidor) {
  if (servidor) {
    // close() sozinho espera as conexões keep-alive ociosas expirarem.
    servidor.closeAllConnections?.();
    await new Promise((resolve) => servidor.close(resolve));
  }
}

async function parar(servidor) {
  await fechar(servidor);
  await encerrar();
}

module.exports = { iniciar, parar, fechar };
