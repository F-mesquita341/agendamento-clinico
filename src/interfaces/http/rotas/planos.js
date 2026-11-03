'use strict';

const { Router } = require('express');
const { RepositorioDePlanosPg } = require('../../../infra/db/RepositorioDePlanosPg');
const apresentar = require('../apresentadores');

const rotas = Router();
const planos = new RepositorioDePlanosPg();

/**
 * GET /planos — versão 2.
 *
 * Os planos aceitos por ao menos um profissional ativo, para o filtro da
 * busca. Cache de 5 minutos, pelo mesmo motivo das cidades.
 */
rotas.get('/', async (req, res, next) => {
  try {
    const itens = await planos.listar();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ planos: itens.map(apresentar.plano) });
  } catch (erro) {
    next(erro);
  }
});

module.exports = rotas;
