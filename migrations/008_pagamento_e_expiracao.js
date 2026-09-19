'use strict';

/**
 * Pagamento pelo Mercado Pago e expiração de reservas não pagas.
 *
 * Três mudanças, cada uma com uma garantia que o banco passa a dar:
 *
 * 1. `consulta.motivo_cancelamento` — por que a consulta foi cancelada: pelo
 *    paciente, ou porque a reserva expirou sem pagamento. A diferença importa
 *    para a análise de absenteísmo, que é o problema central do trabalho: quem
 *    desiste ativamente e quem abandona o checkout são fenômenos diferentes. A
 *    restrição exige motivo em toda consulta cancelada, e só nelas.
 *
 * 2. `pagamento.preferencia_id` e `pagamento.checkout_url` — o checkout criado
 *    no Mercado Pago, para ser reaproveitado quando o paciente pede o pagamento
 *    de novo. Dois checkouts abertos para a mesma consulta permitiriam pagar
 *    duas vezes; o índice único parcial impede o segundo.
 *
 * 3. Índices para as duas buscas novas: reservas vencidas, pela rotina de
 *    expiração, e pagamentos pela referência externa, pelo webhook.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE consulta ADD COLUMN motivo_cancelamento TEXT
      CHECK (motivo_cancelamento IN ('paciente', 'reserva_expirada'));

    -- Até aqui, o único jeito de cancelar era o paciente pedir.
    UPDATE consulta SET motivo_cancelamento = 'paciente' WHERE status = 'cancelada';

    ALTER TABLE consulta ADD CONSTRAINT consulta_motivo_so_quando_cancelada
      CHECK ((status = 'cancelada') = (motivo_cancelamento IS NOT NULL));

    ALTER TABLE pagamento ADD COLUMN preferencia_id TEXT;
    ALTER TABLE pagamento ADD COLUMN checkout_url TEXT;

    -- Um checkout aberto por consulta: pendente e ainda sem pagamento do
    -- Mercado Pago associado.
    CREATE UNIQUE INDEX pagamento_um_checkout_aberto
      ON pagamento (consulta_id)
      WHERE status = 'pendente' AND pagamento_externo_id IS NULL;

    CREATE INDEX idx_pagamento_referencia ON pagamento (referencia_externa);

    CREATE INDEX idx_consulta_reserva_vencida
      ON consulta (reserva_expira_em)
      WHERE status = 'pendente_pagamento';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_consulta_reserva_vencida;
    DROP INDEX IF EXISTS idx_pagamento_referencia;
    DROP INDEX IF EXISTS pagamento_um_checkout_aberto;
    ALTER TABLE pagamento DROP COLUMN IF EXISTS checkout_url;
    ALTER TABLE pagamento DROP COLUMN IF EXISTS preferencia_id;
    ALTER TABLE consulta DROP CONSTRAINT IF EXISTS consulta_motivo_so_quando_cancelada;
    ALTER TABLE consulta DROP COLUMN IF EXISTS motivo_cancelamento;
  `);
};
