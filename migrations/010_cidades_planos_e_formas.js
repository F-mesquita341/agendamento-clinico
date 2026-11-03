'use strict';

/**
 * Versão 2 ("iFood mínimo"), Etapa 20: cidade, planos de saúde e formas de
 * pagamento no catálogo. Só a homologação recebe esta migration enquanto a
 * coleta durar — a produção da v1.0.0 não muda.
 *
 * Tudo aditivo: as linhas que já existem continuam válidas sem nenhuma
 * atualização (clínica sem cidade nem coordenadas, profissional aceitando
 * pagamento pelo aplicativo, como sempre).
 *
 * 1. **`cidade` em tabela própria**, e não texto livre na clínica: "Quixadá" e
 *    "Quixada" seriam duas cidades na lista de escolha, e o filtro por cidade
 *    acharia metade das clínicas.
 *
 * 2. **Coordenadas na clínica**, para o aparelho calcular a distância. A
 *    localização do paciente nunca chega à API; só a da clínica sai dela. As
 *    duas vêm juntas ou nenhuma: meia coordenada não localiza nada.
 *
 * 3. **Planos de saúde** e os que cada profissional aceita (N:N).
 *
 * 4. **Formas de pagamento** do profissional. Pagar pelo aplicativo continua o
 *    padrão; pagar na clínica é opção dele. Plano é forma adicional, que vale
 *    quando há ao menos um plano cadastrado. A restrição garante que todo
 *    profissional aceite ao menos o aplicativo ou a clínica: assim a lista de
 *    formas que a API devolve nunca sai vazia, e quem garante é o banco, não
 *    o cuidado de quem cadastra.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE cidade (
      id   BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      uf   CHAR(2) NOT NULL CONSTRAINT cidade_uf_valida CHECK (uf ~ '^[A-Z]{2}$'),
      CONSTRAINT cidade_unica UNIQUE (nome, uf)
    );

    ALTER TABLE clinica
      ADD COLUMN cidade_id BIGINT REFERENCES cidade(id),
      ADD COLUMN latitude  DOUBLE PRECISION
        CONSTRAINT clinica_latitude_valida CHECK (latitude BETWEEN -90 AND 90),
      ADD COLUMN longitude DOUBLE PRECISION
        CONSTRAINT clinica_longitude_valida CHECK (longitude BETWEEN -180 AND 180),
      ADD CONSTRAINT clinica_coordenadas_juntas
        CHECK ((latitude IS NULL) = (longitude IS NULL));

    CREATE INDEX idx_clinica_cidade ON clinica (cidade_id);

    CREATE TABLE plano_de_saude (
      id   BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL CONSTRAINT plano_de_saude_nome_unico UNIQUE
    );

    CREATE TABLE profissional_plano (
      profissional_id BIGINT NOT NULL REFERENCES profissional(id) ON DELETE CASCADE,
      plano_id        BIGINT NOT NULL REFERENCES plano_de_saude(id),
      PRIMARY KEY (profissional_id, plano_id)
    );

    -- O filtro "aceita este plano" parte do plano; a chave primária começa
    -- pelo profissional e não serve a essa busca.
    CREATE INDEX idx_profissional_plano_plano ON profissional_plano (plano_id);

    ALTER TABLE profissional
      ADD COLUMN aceita_pagamento_no_app BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN aceita_pagar_na_clinica BOOLEAN NOT NULL DEFAULT false,
      ADD CONSTRAINT profissional_aceita_alguma_forma
        CHECK (aceita_pagamento_no_app OR aceita_pagar_na_clinica);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE profissional
      DROP CONSTRAINT IF EXISTS profissional_aceita_alguma_forma,
      DROP COLUMN IF EXISTS aceita_pagar_na_clinica,
      DROP COLUMN IF EXISTS aceita_pagamento_no_app;

    DROP TABLE IF EXISTS profissional_plano;
    DROP TABLE IF EXISTS plano_de_saude;

    DROP INDEX IF EXISTS idx_clinica_cidade;
    ALTER TABLE clinica
      DROP CONSTRAINT IF EXISTS clinica_coordenadas_juntas,
      DROP COLUMN IF EXISTS longitude,
      DROP COLUMN IF EXISTS latitude,
      DROP COLUMN IF EXISTS cidade_id;

    DROP TABLE IF EXISTS cidade;
  `);
};
