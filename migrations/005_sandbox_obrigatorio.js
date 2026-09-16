'use strict';

/**
 * Faz a restrição cumprir o que o comentário já prometia.
 *
 * A migration 003 descrevia `pagamento.ambiente` como "trava de segurança
 * acadêmica: nenhuma linha com ambiente 'producao' deve existir" — mas a
 * restrição era `CHECK (ambiente IN ('sandbox','producao'))`, que aceita
 * 'producao' em silêncio. Comentário e schema diziam coisas diferentes, e o
 * comentário é o que um mantenedor lê antes de decidir se precisa de proteção
 * na aplicação.
 *
 * O projeto de pesquisa declara, na Seção 3.9.5 e no Quadro 2, que a integração
 * de pagamento ocorre exclusivamente em sandbox. A restrição passa a dizer o
 * mesmo: um INSERT copiado de exemplo do Mercado Pago com credencial de
 * produção agora falha no banco, em vez de ser gravado sem alarde.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE pagamento DROP CONSTRAINT IF EXISTS pagamento_ambiente_check;
    ALTER TABLE pagamento
      ADD CONSTRAINT pagamento_ambiente_check CHECK (ambiente = 'sandbox');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE pagamento DROP CONSTRAINT IF EXISTS pagamento_ambiente_check;
    ALTER TABLE pagamento
      ADD CONSTRAINT pagamento_ambiente_check
      CHECK (ambiente IN ('sandbox', 'producao'));
  `);
};
