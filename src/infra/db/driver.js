'use strict';

/**
 * Escolha do transporte até o PostgreSQL.
 *
 * O caminho normal é TCP na porta 5432, com o driver `pg`. Algumas redes
 * gerenciadas — faculdades, empresas, alguns provedores — liberam apenas 80 e
 * 443 e barram o resto, e aí a conexão simplesmente estoura o tempo limite.
 *
 * Para esses casos o Neon oferece um driver que fala o protocolo do PostgreSQL
 * sobre WebSocket, na 443. A API é compatível com a do `pg`, então só o
 * transporte muda: o banco continua sendo PostgreSQL, o SQL é o mesmo e o
 * controle de concorrência continua sendo o do próprio banco.
 *
 * Importante: usamos o modo WebSocket, e não o modo HTTP do mesmo pacote. O
 * modo HTTP não sustenta transação, e o agendamento com lock otimista depende
 * de BEGIN/COMMIT explícito.
 *
 * Selecionado por TRANSPORTE_BANCO no .env: 'tcp' (padrão) ou 'websocket'.
 */

const config = require('../../config');

function carregar() {
  if (config.TRANSPORTE_BANCO === 'websocket') {
    const { Pool, Client, neonConfig } = require('@neondatabase/serverless');

    // Em ambiente Node é preciso dizer ao driver qual implementação de
    // WebSocket usar. O Node 22+ traz uma nativa; o pacote `ws` cobre o resto.
    neonConfig.webSocketConstructor = require('ws');

    return { Pool, Client, transporte: 'websocket', porta: 443 };
  }

  const { Pool, Client } = require('pg');
  return { Pool, Client, transporte: 'tcp', porta: 5432 };
}

module.exports = carregar();
