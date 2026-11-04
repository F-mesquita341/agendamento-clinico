'use strict';

/**
 * Versão 2 ("iFood mínimo"), Etapa 21: a forma de pagamento escolhida no
 * agendamento. Só a homologação recebe esta migration enquanto a coleta
 * durar — a produção da v1.0.0 não muda.
 *
 * Aditiva: toda consulta que já existe foi paga (ou abandonada) pelo
 * aplicativo, e é isso que o padrão 'app' registra.
 *
 * Três restrições guardam a regra no banco, e não só no código:
 *
 * 1. Plano escolhido se, e somente se, a forma é plano.
 * 2. Só o pagamento pelo aplicativo tem reserva à espera de pagamento: plano e
 *    "na clínica" nascem confirmados, sem checkout.
 * 3. E, pelo mesmo motivo, só ele tem prazo de reserva — uma consulta de plano
 *    com prazo seria apanhada pela rotina de expiração.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE consulta
      ADD COLUMN forma_de_pagamento TEXT NOT NULL DEFAULT 'app'
        CONSTRAINT consulta_forma_de_pagamento_conhecida
        CHECK (forma_de_pagamento IN ('app', 'plano', 'clinica')),
      ADD COLUMN plano_id BIGINT REFERENCES plano_de_saude(id),
      ADD CONSTRAINT consulta_plano_so_com_forma_plano
        CHECK ((forma_de_pagamento = 'plano') = (plano_id IS NOT NULL)),
      ADD CONSTRAINT consulta_pendente_so_pelo_app
        CHECK (forma_de_pagamento = 'app' OR status <> 'pendente_pagamento'),
      ADD CONSTRAINT consulta_reserva_so_pelo_app
        CHECK (forma_de_pagamento = 'app' OR reserva_expira_em IS NULL);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE consulta
      DROP CONSTRAINT IF EXISTS consulta_reserva_so_pelo_app,
      DROP CONSTRAINT IF EXISTS consulta_pendente_so_pelo_app,
      DROP CONSTRAINT IF EXISTS consulta_plano_so_com_forma_plano,
      DROP COLUMN IF EXISTS plano_id,
      DROP COLUMN IF EXISTS forma_de_pagamento;
  `);
};
