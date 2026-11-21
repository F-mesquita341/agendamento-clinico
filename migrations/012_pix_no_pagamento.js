'use strict';

/**
 * Pix como segundo meio de pagar pelo aplicativo (só na versão 2, e só com
 * PIX_HABILITADO ligado).
 *
 * Só acréscimo. Toda linha que já existe é um checkout do Checkout Pro e ganha
 * `meio = 'checkout'` pelo padrão; nenhum código anterior lê as colunas novas,
 * então a versão sem Pix roda igual sobre esta tabela — é isso que torna o
 * Rollback do Render (voltar o código sem desfazer a migration) seguro.
 *
 * O índice `pagamento_um_checkout_aberto` (migration 008) não muda: um
 * pagamento aberto por consulta, qualquer que seja o meio. É ele que impede
 * pagar a mesma consulta pelo Pix e pelo Checkout Pro ao mesmo tempo.
 *
 * O "copia e cola" e a imagem do QR ficam guardados para que pedir o Pix de
 * novo devolva o mesmo, sem criar outro pedido no Mercado Pago. Não são dado
 * do paciente: descrevem a cobrança.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE pagamento
      ADD COLUMN meio TEXT NOT NULL DEFAULT 'checkout'
        CONSTRAINT pagamento_meio_conhecido CHECK (meio IN ('checkout', 'pix')),
      ADD COLUMN pix_copia_e_cola TEXT,
      ADD COLUMN pix_qr_base64 TEXT;

    -- O "copia e cola" existe se, e somente se, o meio é Pix; a imagem, só no Pix.
    ALTER TABLE pagamento
      ADD CONSTRAINT pagamento_copia_e_cola_so_no_pix
        CHECK ((meio = 'pix') = (pix_copia_e_cola IS NOT NULL)),
      ADD CONSTRAINT pagamento_qr_so_no_pix
        CHECK (meio = 'pix' OR pix_qr_base64 IS NULL);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE pagamento
      DROP CONSTRAINT IF EXISTS pagamento_qr_so_no_pix,
      DROP CONSTRAINT IF EXISTS pagamento_copia_e_cola_so_no_pix,
      DROP COLUMN IF EXISTS pix_qr_base64,
      DROP COLUMN IF EXISTS pix_copia_e_cola,
      DROP COLUMN IF EXISTS meio;
  `);
};
