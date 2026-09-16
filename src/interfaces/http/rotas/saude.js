'use strict';

/**
 * GET /saude
 *
 * Healthcheck. O Render consulta esta rota para saber se o serviço subiu.
 * Responde 200 quando a API e o banco estão de pé, 503 quando o banco não
 * responde — assim uma falha de conexão aparece aqui, e não só quando um
 * paciente tenta agendar.
 *
 * A consulta é limitada por um prazo próprio, bem menor que o tempo de conexão
 * do pool (15 s em TCP, 30 s por WebSocket). Sem esse limite, uma sondagem
 * durante a hibernação do Neon seguraria um processo de trabalho por meia
 * dezena de segundos antes de responder qualquer coisa — o oposto do que um
 * healthcheck existe para fazer. Uma rajada de sondagens esgotaria a
 * capacidade da API enquanto ela apenas "parecia lenta".
 */

const { Router } = require('express');
const { consultar } = require('../../../infra/db/pool');

const rotas = Router();

const PRAZO_MS = 3000;

/** Resolve com o resultado, ou rejeita ao estourar o prazo. */
function comPrazo(promessa, prazoMs) {
  let temporizador;
  const limite = new Promise((_, rejeitar) => {
    temporizador = setTimeout(
      () => rejeitar(new Error(`banco não respondeu em ${prazoMs} ms`)),
      prazoMs
    );
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(temporizador));
}

rotas.get('/saude', async (req, res) => {
  const inicio = Date.now();
  try {
    await comPrazo(consultar('SELECT 1'), PRAZO_MS);
    res.json({
      status: 'ok',
      banco: 'conectado',
      latencia_ms: Date.now() - inicio,
    });
  } catch (erro) {
    console.error('Healthcheck falhou:', erro.message);
    res.status(503).json({
      status: 'degradado',
      banco: 'indisponivel',
      latencia_ms: Date.now() - inicio,
    });
  }
});

module.exports = rotas;
