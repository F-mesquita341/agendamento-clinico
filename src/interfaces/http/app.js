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
const { criarLimiteDeEscritas } = require('./middlewares/limitarEscritas');
const { criarVerificadorFirebase } = require('../../infra/firebase/verificadorDeToken');
const { criarGatewayDePagamento } = require('../../infra/pagamento');
const { rotaNaoEncontrada, tratadorDeErro } = require('./middlewares/erro');

/**
 * @param {object} [deps]
 * @param {Function} [deps.verificarToken] verificador do Firebase; falso nos testes
 * @param {object} [deps.gateway] provedor de pagamento; nos testes, um dublê sem
 *        rede. Sem credencial configurada, o padrão responde "indisponível".
 * @param {string} [deps.segredoDoWebhook] chave que assina os avisos do provedor
 * @param {string|string[]} [deps.origens] origens do CORS; padrão, as da configuração
 * @param {number} [deps.limiteDeEscritas] escritas por paciente por minuto; os
 *        testes passam um valor alto, para não tropeçar num limite que não é o
 *        assunto deles
 */
function criarApp({
  verificarToken = criarVerificadorFirebase(),
  gateway = criarGatewayDePagamento(),
  segredoDoWebhook = config.MERCADO_PAGO_SEGREDO_WEBHOOK,
  origens = config.origens,
  limiteDeEscritas = config.LIMITE_ESCRITAS_POR_MINUTO,
  pacientes,
  horarios,
  consultas,
  pagamentos,
  dispositivos,
  relogio,
} = {}) {
  const app = express();

  // Uma instância só, repassada a todos os roteadores: o orçamento é do
  // paciente, somado entre as rotas de escrita.
  const limitarEscritas = criarLimiteDeEscritas({ limitePorMinuto: limiteDeEscritas });

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: origens,
      // Sem isto, o navegador esconde do JavaScript os cabeçalhos do limite de
      // escritas: fora da lista curta que o CORS libera por padrão, só aparece
      // o que o servidor expõe. O aplicativo Android os lê de qualquer jeito.
      exposedHeaders: ['Retry-After', 'RateLimit', 'RateLimit-Policy'],
    })
  );
  app.use(express.json({ limit: '100kb' }));

  app.use(saude);
  app.use('/especialidades', especialidades);
  app.use('/profissionais', profissionais);
  app.use('/pacientes', criarRotasDePacientes({ verificarToken, pacientes, relogio, limitarEscritas }));
  // `horarios` e `consultas` só são informados pelo teste de carga, que mede
  // quantas recusas foram decididas pelo lock; ausentes, a rota usa os
  // adaptadores PostgreSQL de sempre.
  app.use(
    '/consultas',
    criarRotasDeConsultas({
      verificarToken,
      gateway,
      pacientes,
      horarios,
      consultas,
      pagamentos,
      relogio,
      limitarEscritas,
    })
  );
  app.use('/dispositivos', criarRotasDeDispositivos({ verificarToken, pacientes, dispositivos, limitarEscritas }));
  app.use('/webhooks', criarRotasDeWebhook({ gateway, segredo: segredoDoWebhook, pagamentos }));

  app.use(rotaNaoEncontrada);
  app.use(tratadorDeErro);

  return app;
}

module.exports = { criarApp };
