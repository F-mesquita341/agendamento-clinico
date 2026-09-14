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
 *   beforeAll(() => { servidor = iniciar(); });
 *   afterAll(() => parar(servidor));
 *   // ...
 *   await request(servidor).get('/saude');
 */

const app = require('../../src/interfaces/http/app');
const { consultar, encerrar } = require('../../src/infra/db/pool');

async function iniciar() {
  // Porta 0: o sistema operacional escolhe uma livre.
  const servidor = app.listen(0);

  // O plano gratuito do Neon suspende o compute quando fica ocioso. A primeira
  // consulta depois disso leva vários segundos para acordá-lo, o que estourava
  // o tempo limite de um teste e o fazia falhar sem que houvesse nada errado.
  // Acordar o banco aqui, no setup, faz cada teste medir o que ele pretende
  // medir — e não a hibernação da infraestrutura.
  await consultar('SELECT 1');

  return servidor;
}

async function parar(servidor) {
  if (servidor) {
    // close() sozinho espera as conexões keep-alive ociosas expirarem.
    servidor.closeAllConnections?.();
    await new Promise((resolve) => servidor.close(resolve));
  }
  await encerrar();
}

module.exports = { iniciar, parar };
