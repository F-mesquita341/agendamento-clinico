'use strict';

/**
 * Montagem do aplicativo Express.
 *
 * Separado de servidor.js de propósito: os testes de integração importam
 * `app` e o Supertest sobe sua própria porta. Nenhum teste precisa que a
 * API esteja rodando de verdade.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const config = require('../../config');
const saude = require('./rotas/saude');
const { rotaNaoEncontrada, tratadorDeErro } = require('./middlewares/erro');

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.origens }));
app.use(express.json({ limit: '100kb' }));

app.use(saude);

// A partir da Etapa 4, as demais rotas entram aqui:
// app.use('/especialidades', especialidades);
// app.use('/profissionais', profissionais);
// app.use('/pacientes', pacientes);
// app.use('/consultas', consultas);

app.use(rotaNaoEncontrada);
app.use(tratadorDeErro);

module.exports = app;
