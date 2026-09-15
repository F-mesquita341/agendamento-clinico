'use strict';

/**
 * Habilita `unaccent`, usada na busca de profissionais por nome.
 *
 * Sem ela, procurar por "jose" não encontra "José" e procurar por "ines" não
 * encontra "Inês" — o que quebra a busca justamente para os nomes mais comuns
 * no Brasil. Combinada com ILIKE, resolve acento e caixa de uma vez.
 *
 * A extensão faz parte da distribuição padrão do PostgreSQL e está disponível
 * no Neon.
 */

exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS unaccent;');
};

exports.down = (pgm) => {
  // Não removemos a extensão: outros objetos podem ter passado a depender dela,
  // e derrubá-la num rollback causaria mais dano do que deixá-la instalada.
  pgm.sql('-- extensão unaccent mantida de propósito');
};
