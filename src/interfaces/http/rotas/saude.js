'use strict';

/**
 * GET /saude
 *
 * Healthcheck. O Render consulta esta rota para saber se o serviço subiu.
 * Responde 200 quando a API e o banco estão de pé, 503 quando o banco não
 * responde — assim uma falha de conexão aparece aqui, e não só quando um
 * paciente tenta agendar.
 */

const { Router } = require('express');
const { consultar } = require('../../../infra/db/pool');

const rotas = Router();

rotas.get('/saude', async (req, res) => {
  const inicio = Date.now();
  try {
    await consultar('SELECT 1');
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
    });
  }
});

module.exports = rotas;
