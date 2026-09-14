'use strict';

/**
 * Pagamento, dispositivos e auditoria.
 *
 * A tabela `auditoria` atende ao que Fachin e Domingues (2022) apontam, e que
 * o Capítulo 3.4.1 do projeto cita: medidas técnicas proporcionais ao risco,
 * incluindo REGISTRO DAS OPERAÇÕES DE TRATAMENTO de dado sensível.
 *
 * Regra ao escrever em auditoria: `detalhe` guarda o que mudou, nunca o dado
 * clínico em si. Registrar "consulta.criada" com o id basta; copiar para lá a
 * especialidade ou o motivo da consulta só espalharia dado sensível por mais
 * uma tabela.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE status_pagamento AS ENUM (
      'pendente', 'aprovado', 'recusado', 'estornado', 'expirado'
    );

    CREATE TABLE pagamento (
      id                   BIGSERIAL PRIMARY KEY,
      consulta_id          BIGINT NOT NULL REFERENCES consulta(id),
      provedor             TEXT NOT NULL DEFAULT 'mercado_pago',

      -- Trava de segurança acadêmica: este trabalho opera exclusivamente em
      -- sandbox. Nenhuma linha com ambiente 'producao' deve existir.
      ambiente             TEXT NOT NULL DEFAULT 'sandbox'
        CHECK (ambiente IN ('sandbox', 'producao')),

      referencia_externa   TEXT,
      pagamento_externo_id TEXT,
      status               status_pagamento NOT NULL DEFAULT 'pendente',
      valor_centavos       INTEGER NOT NULL CHECK (valor_centavos >= 0),
      criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_pagamento_consulta ON pagamento (consulta_id);

    -- O Mercado Pago reenvia a mesma notificação várias vezes. Este índice
    -- torna o processamento do webhook idempotente.
    CREATE UNIQUE INDEX idx_pagamento_externo
      ON pagamento (pagamento_externo_id)
      WHERE pagamento_externo_id IS NOT NULL;

    CREATE TABLE device_token (
      id          BIGSERIAL PRIMARY KEY,
      paciente_id BIGINT NOT NULL REFERENCES paciente(id) ON DELETE CASCADE,
      token       TEXT NOT NULL UNIQUE,
      plataforma  TEXT NOT NULL DEFAULT 'android',
      criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE auditoria (
      id          BIGSERIAL PRIMARY KEY,
      ator_tipo   TEXT NOT NULL CHECK (
                    ator_tipo IN ('paciente', 'sistema', 'webhook')
                  ),
      ator_id     BIGINT,
      acao        TEXT NOT NULL,
      entidade    TEXT NOT NULL,
      entidade_id BIGINT,
      detalhe     JSONB,
      criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_auditoria_entidade
      ON auditoria (entidade, entidade_id, criado_em DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS auditoria;
    DROP TABLE IF EXISTS device_token;
    DROP TABLE IF EXISTS pagamento;
    DROP TYPE IF EXISTS status_pagamento;
  `);
};
