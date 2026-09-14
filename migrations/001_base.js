'use strict';

/**
 * Entidades base do domínio: clínica, especialidade, profissional e paciente.
 *
 * Nomes em português, iguais aos do projeto de pesquisa e aos que a clínica
 * usa no dia a dia — a linguagem ubíqua de Evans (2016) só funciona se for a
 * mesma no código, no banco e na conversa com a recepção.
 *
 * Dinheiro é guardado em CENTAVOS, como inteiro. Ponto flutuante para valor
 * monetário acumula erro de arredondamento.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE clinica (
      id         BIGSERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      cnpj       TEXT UNIQUE,
      telefone   TEXT,
      endereco   TEXT,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE especialidade (
      id    BIGSERIAL PRIMARY KEY,
      nome  TEXT NOT NULL UNIQUE
    );

    CREATE TABLE profissional (
      id                      BIGSERIAL PRIMARY KEY,
      clinica_id              BIGINT NOT NULL REFERENCES clinica(id),
      especialidade_id        BIGINT NOT NULL REFERENCES especialidade(id),
      nome                    TEXT NOT NULL,
      registro_conselho       TEXT NOT NULL,
      valor_consulta_centavos INTEGER NOT NULL
        CHECK (valor_consulta_centavos >= 0),
      ativo                   BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em               TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_profissional_especialidade
      ON profissional (especialidade_id)
      WHERE ativo;

    CREATE TABLE paciente (
      id              BIGSERIAL PRIMARY KEY,
      firebase_uid    TEXT NOT NULL UNIQUE,
      nome            TEXT NOT NULL,
      email           TEXT NOT NULL,
      telefone        TEXT,
      data_nascimento DATE,

      -- LGPD, Art. 11: o tratamento de dado de saúde depende de consentimento
      -- específico e destacado. Guardamos QUANDO foi dado e QUAL texto foi
      -- aceito — sem isso, não há como provar o consentimento depois.
      consentimento_versao TEXT,
      consentimento_em     TIMESTAMPTZ,

      criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS paciente;
    DROP TABLE IF EXISTS profissional;
    DROP TABLE IF EXISTS especialidade;
    DROP TABLE IF EXISTS clinica;
  `);
};
