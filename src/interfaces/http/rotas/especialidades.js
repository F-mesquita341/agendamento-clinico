'use strict';

const { Router } = require('express');
const {
  RepositorioDeEspecialidadesPg,
} = require('../../../infra/db/RepositorioDeEspecialidadesPg');
const apresentar = require('../apresentadores');

const rotas = Router();
const especialidades = new RepositorioDeEspecialidadesPg();

/**
 * GET /especialidades
 *
 * Lista fechada e de baixa rotatividade — o cabeçalho de cache permite que o
 * aplicativo evite refazer esta chamada a cada busca.
 */
rotas.get('/', async (req, res, next) => {
  try {
    const itens = await especialidades.listar();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ especialidades: itens.map(apresentar.especialidade) });
  } catch (erro) {
    next(erro);
  }
});

module.exports = rotas;
