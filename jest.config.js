'use strict';

/**
 * O Jest define NODE_ENV=test automaticamente, e é por isso que config.js
 * passa a exigir DATABASE_URL_TESTE ao rodar a suíte. Essa exigência é
 * deliberada: impede que um teste apague o banco de desenvolvimento.
 */

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],

  // Os testes de integração falam com um PostgreSQL remoto, em São Paulo, que
  // ainda por cima hiberna no plano gratuito. Os 5 segundos padrão do Jest são
  // apertados demais para o primeiro acesso depois de um período ocioso.
  testTimeout: 30_000,
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  verbose: true,
};
