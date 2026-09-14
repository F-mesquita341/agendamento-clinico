'use strict';

/**
 * Horários e consultas — o núcleo do controle de concorrência.
 *
 * DUAS defesas, com papéis diferentes:
 *
 * 1. horario.versao — o lock otimista (Optimistic Offline Lock, FOWLER, 2006).
 *    É o mecanismo da aplicação, e é sobre ele que o Capítulo 5 discorre.
 *
 * 2. O índice único parcial em consulta — a garantia do banco. Se algum
 *    caminho futuro esquecer de comparar a versão, o PostgreSQL ainda recusa
 *    a segunda consulta ativa no mesmo horário.
 *
 * O índice é PARCIAL, e não um UNIQUE simples, por um motivo concreto: quando
 * um paciente cancela, o horário volta a ficar disponível e outra pessoa
 * precisa poder agendá-lo. Um UNIQUE (horario_id) comum impediria isso para
 * sempre, porque a consulta cancelada continua na tabela — e ela precisa
 * continuar, tanto para histórico quanto para a análise de absenteísmo.
 * Só 'cancelada' libera o horário; qualquer outro estado o ocupa.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE status_horario AS ENUM (
      'disponivel', 'reservado', 'bloqueado'
    );

    CREATE TYPE status_consulta AS ENUM (
      'pendente_pagamento', 'confirmada', 'cancelada',
      'realizada', 'nao_compareceu'
    );

    CREATE TABLE horario (
      id              BIGSERIAL PRIMARY KEY,
      profissional_id BIGINT NOT NULL REFERENCES profissional(id),
      inicio          TIMESTAMPTZ NOT NULL,
      fim             TIMESTAMPTZ NOT NULL,
      status          status_horario NOT NULL DEFAULT 'disponivel',

      -- Incrementada a cada mudança de estado. É o valor que o aplicativo
      -- devolve no POST /consultas e que a cláusula WHERE compara.
      versao          INTEGER NOT NULL DEFAULT 0,

      criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT horario_intervalo_valido CHECK (fim > inicio),
      CONSTRAINT horario_unico_por_profissional UNIQUE (profissional_id, inicio)
    );

    -- Sustenta GET /profissionais/:id/horarios, que é a consulta mais quente
    -- da API: sempre filtra por profissional, faixa de data e disponibilidade.
    CREATE INDEX idx_horario_disponivel
      ON horario (profissional_id, inicio)
      WHERE status = 'disponivel';

    CREATE TABLE consulta (
      id                  BIGSERIAL PRIMARY KEY,
      paciente_id         BIGINT NOT NULL REFERENCES paciente(id),
      horario_id          BIGINT NOT NULL REFERENCES horario(id),
      status              status_consulta NOT NULL DEFAULT 'pendente_pagamento',
      valor_centavos      INTEGER NOT NULL CHECK (valor_centavos >= 0),

      -- Até quando a reserva não paga se sustenta. Passou disso, rotina
      -- agendada cancela e devolve o horário para 'disponivel'.
      reserva_expira_em   TIMESTAMPTZ,

      -- Marcada quando o lembrete das 24h é disparado, para não reenviar
      -- a cada execução da rotina.
      lembrete_enviado_em TIMESTAMPTZ,

      criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A garantia do banco. Ver o comentário no topo do arquivo.
    CREATE UNIQUE INDEX consulta_horario_ativo
      ON consulta (horario_id)
      WHERE status <> 'cancelada';

    CREATE INDEX idx_consulta_paciente
      ON consulta (paciente_id, criado_em DESC);

    -- Sustenta a rotina de lembretes: consultas confirmadas que começam em
    -- breve e ainda não foram avisadas.
    CREATE INDEX idx_consulta_lembrete
      ON consulta (status)
      WHERE lembrete_enviado_em IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS consulta;
    DROP TABLE IF EXISTS horario;
    DROP TYPE IF EXISTS status_consulta;
    DROP TYPE IF EXISTS status_horario;
  `);
};
