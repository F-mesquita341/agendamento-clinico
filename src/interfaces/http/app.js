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
const { criarRotasDeWebhook } = require('./rotas/webhooks');
const { criarRotasDeDispositivos } = require('./rotas/dispositivos');
const { criarVerificadorFirebase } = require('../../infra/firebase/verificadorDeToken');
const { criarGatewayDePagamento } = require('../../infra/pagamento');
const { rotaNaoEncontrada, tratadorDeErro } = require('./middlewares/erro');

/**
 * @param {object} [deps]
 * @param {Function} [deps.verificarToken] verificador do Firebase; falso nos testes
 * @param {object} [deps.gateway] provedor de pagamento; nos testes, um dublê sem
 *        rede. Sem credencial configurada, o padrão responde "indisponível".
 * @param {string} [deps.segredoDoWebhook] chave que assina os avisos do provedor
 */
function criarApp({
  verificarToken = criarVerificadorFirebase(),
  gateway = criarGatewayDePagamento(),
  segredoDoWebhook = config.MERCADO_PAGO_SEGREDO_WEBHOOK,
  pacientes,
  horarios,
  consultas,
  pagamentos,
  dispositivos,
  relogio,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.origens }));
  app.use(express.json({ limit: '100kb' }));

  app.use(saude);
  app.use('/especialidades', especialidades);
  app.use('/profissionais', profissionais);
  app.use('/pacientes', criarRotasDePacientes({ verificarToken, pacientes, relogio }));
  // `horarios` e `consultas` só são informados pelo teste de carga, que mede
  // quantas recusas foram decididas pelo lock; ausentes, a rota usa os
  // adaptadores PostgreSQL de sempre.
  app.use(
    '/consultas',
    criarRotasDeConsultas({ verificarToken, gateway, pacientes, horarios, consultas, pagamentos, relogio })
  );
  app.use('/dispositivos', criarRotasDeDispositivos({ verificarToken, pacientes, dispositivos }));
  app.use('/webhooks', criarRotasDeWebhook({ gateway, segredo: segredoDoWebhook, pagamentos }));

  app.use(rotaNaoEncontrada);
  app.use(tratadorDeErro);

  return app;
}

module.exports = { criarApp };
