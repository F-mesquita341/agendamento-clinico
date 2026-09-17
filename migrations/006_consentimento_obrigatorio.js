'use strict';

/**
 * Consentimento passa a ser obrigatório no próprio banco.
 *
 * A migration 001 criou `consentimento_versao` e `consentimento_em` aceitando
 * nulo. A aplicação já recusa cadastro sem consentimento, mas uma regra que só
 * existe na aplicação é contornável: um script de manutenção, uma importação,
 * um INSERT manual pelo painel. Com NOT NULL, é o PostgreSQL que garante que
 * não existe paciente sem prova de consentimento — a exigência do Art. 11 da
 * LGPD, citado na Seção 3.4.1 do projeto.
 *
 * Aplicável sem migração de dados: a tabela estava vazia nos dois bancos no
 * momento em que esta migration foi escrita.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE paciente
      ALTER COLUMN consentimento_versao SET NOT NULL,
      ALTER COLUMN consentimento_em     SET NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE paciente
      ALTER COLUMN consentimento_versao DROP NOT NULL,
      ALTER COLUMN consentimento_em     DROP NOT NULL;
  `);
};
