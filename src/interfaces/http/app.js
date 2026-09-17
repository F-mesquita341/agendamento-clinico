'use strict';

/**
 * Montagem do aplicativo Express.
 *
 * Exporta uma fábrica, e não uma instância pronta, para que as dependências
 * de fronteira sejam injetadas por quem monta o app — a mesma ideia já usada
 * nos casos de uso. Hoje a principal é o verificador de token:
 *
 *   em produção:  criarApp()                      → verificador do Firebase
 *   nos testes:   criarApp({ verificarToken })    → verificador falso, sem rede
 *
 * Separado de servidor.js para que os testes subam o app numa porta própria,
 * sem depender de a API estar rodando.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const config = require('../../config');
const saude = require('./rotas/saude');
const especialidades = require('./rotas/especialidades');
const profissionais = require('./rotas/profissionais');
const { criarRotasDePacientes } = require('./rotas/pacientes');
const { criarRotasDeConsultas } = require('./rotas/consultas');
const { criarVerificadorFirebase } = require('../../infra/firebase/verificadorDeToken');
const { rotaNaoEncontrada, tratadorDeErro } = require('./middlewares/erro');

function criarApp({ verificarToken = criarVerificadorFirebase(), pacientes, relogio } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.origens }));
  app.use(express.json({ limit: '100kb' }));

  app.use(saude);
  app.use('/especialidades', especialidades);
  app.use('/profissionais', profissionais);
  app.use('/pacientes', criarRotasDePacientes({ verificarToken, pacientes, relogio }));
  app.use('/consultas', criarRotasDeConsultas({ verificarToken, pacientes, relogio }));

  app.use(rotaNaoEncontrada);
  app.use(tratadorDeErro);

  return app;
}

module.exports = { criarApp };
