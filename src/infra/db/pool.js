'use strict';

/**
 * Acesso ao PostgreSQL.
 *
 * Expõe duas coisas:
 *   consultar(sql, valores)  — para leituras e escritas avulsas
 *   transacao(execucao)      — Unit of Work (FOWLER, 2006): abre BEGIN, entrega
 *                              o cliente ao chamador e garante COMMIT ou ROLLBACK.
 *
 * O agendamento com lock otimista roda inteiro dentro de transacao().
 *
 * O transporte (TCP ou WebSocket) é escolhido em ./driver — ver o comentário
 * daquele arquivo. Daqui para baixo, nada muda entre um e outro.
 */

const { Pool, transporte } = require('./driver');
const config = require('../../config');

const url = config.urlDoBanco;
const emTeste = config.NODE_ENV === 'test';
const sobreWebSocket = transporte === 'websocket';

// No transporte WebSocket o TLS é do próprio wss://, e o driver cuida disso.
// No TCP, Neon e Render exigem TLS: o certificado deles vem de autoridade
// pública, então a verificação padrão do Node funciona — não desligue.
//
// A verificação lista os modos que pedem TLS em vez de casar com `sslmode=`
// solto: assim `sslmode=disable`, usado contra um PostgreSQL local, não acaba
// forçando TLS contra um servidor que não o oferece.
const exigeSsl = /sslmode=(require|verify-ca|verify-full)|neon\.tech|render\.com/.test(url);

const opcoes = {
  connectionString: url,
  max: emTeste ? 5 : 10,
  idleTimeoutMillis: 30_000,

  // O WebSocket precisa de mais folga: além do TCP e do TLS, há o handshake
  // do protocolo, e o compute do Neon pode estar hibernando.
  connectionTimeoutMillis: sobreWebSocket ? 30_000 : 15_000,

  // Em teste, não deixa clientes ociosos segurarem o event loop. Sem isto o
  // Jest avisa que "did not exit one second after the test run": o socket
  // demora mais de um segundo para ser liberado depois de pool.end().
  // Em produção o processo é mantido vivo pelo servidor HTTP.
  allowExitOnIdle: emTeste,
};

if (!sobreWebSocket) {
  opcoes.ssl = exigeSsl ? { rejectUnauthorized: true } : false;
}

const pool = new Pool(opcoes);

pool.on('error', (erro) => {
  console.error('Erro em cliente ocioso do pool:', erro.message);
});

function consultar(sql, valores) {
  return pool.query(sql, valores);
}

async function transacao(execucao) {
  const cliente = await pool.connect();
  let devolvido = false;

  try {
    await cliente.query('BEGIN');
    const resultado = await execucao(cliente);
    await cliente.query('COMMIT');
    cliente.release();
    devolvido = true;
    return resultado;
  } catch (erro) {
    if (!devolvido) {
      try {
        await cliente.query('ROLLBACK');
        cliente.release();
      } catch (falhaNoRollback) {
        // O ROLLBACK falha tipicamente quando a própria conexão caiu — que é,
        // quase sempre, o que causou o erro original. Devolver o cliente ao
        // pool COM o erro faz o `pg` destruí-lo, em vez de reaproveitar uma
        // conexão cujo estado transacional é desconhecido: sem isto, o próximo
        // a pegá-la receberia "current transaction is aborted" sem ter feito
        // nada de errado.
        cliente.release(falhaNoRollback);
      }
    }

    // Propaga sempre o erro ORIGINAL. A falha do ROLLBACK é consequência, não
    // causa, e deixá-la substituir o erro real esconderia o que aconteceu.
    throw erro;
  }
}

async function encerrar() {
  await pool.end();
}

module.exports = { pool, consultar, transacao, encerrar, transporte };
