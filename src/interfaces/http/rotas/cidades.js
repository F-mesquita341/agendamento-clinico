'use strict';

const { Router } = require('express');
const { RepositorioDeCidadesPg } = require('../../../infra/db/RepositorioDeCidadesPg');
const apresentar = require('../apresentadores');

const rotas = Router();
const cidades = new RepositorioDeCidadesPg();

/**
 * GET /cidades — versão 2.
 *
 * As cidades com ao menos um profissional ativo, para a lista de escolha do
 * aplicativo. Cadastro que muda pouco: cache de 5 minutos, como o dos
 * profissionais — uma cidade nova não deve demorar uma hora para aparecer.
 */
rotas.get('/', async (req, res, next) => {
  try {
    const itens = await cidades.listar();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ cidades: itens.map(apresentar.cidade) });
  } catch (erro) {
    next(erro);
  }
});

module.exports = rotas;
