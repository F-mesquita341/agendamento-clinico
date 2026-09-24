'use strict';

/**
 * Falsos positivos do auditor do histórico (scripts/auditar-historico.js),
 * revisados um a um.
 *
 * O histórico não muda: sem esta lista, um achado indevido acusaria para
 * sempre, e a integração contínua ficaria vermelha sem saída. Cada exceção
 * precisa coincidir em tudo com o achado — commit, arquivo, linha e tipo —,
 * para não cobrir nada além do que foi revisado:
 *
 *   {
 *     commit: '660256d9ff',          // ao menos 10 dígitos do hash
 *     arquivo: 'docs/diario.md',
 *     linha: 42,                     // null para achado pelo nome do arquivo
 *     tipo: 'valor em variável secreta',
 *     motivo: 'Frase do diário: o "valor" é uma palavra, não uma credencial.',
 *   }
 *
 * SÓ PARA O QUE NÃO É CREDENCIAL. Credencial de verdade não entra aqui: ela se
 * troca. Pôr uma credencial nesta lista não a tira do histórico — só esconde o
 * aviso de que ela continua lá.
 */

module.exports = [];
