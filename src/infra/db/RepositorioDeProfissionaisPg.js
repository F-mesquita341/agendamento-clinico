'use strict';

/**
 * Adaptador PostgreSQL para o catálogo de profissionais.
 *
 * A busca por nome usa `unaccent` combinado com `ILIKE`: um paciente que
 * procura "jose" precisa encontrar "José", e quem digita "ANA" precisa
 * encontrar "Ana". Sem isso, a busca falha justamente para os nomes mais
 * comuns no Brasil.
 */

const { RepositorioDeProfissionais } = require('../../domain/repositorios');
const { Profissional } = require('../../domain/Profissional');
const { Dinheiro } = require('../../domain/Dinheiro');
const { consultar } = require('./pool');

function paraEntidade(linha) {
  return new Profissional({
    id: Number(linha.id),
    clinicaId: Number(linha.clinica_id),
    nome: linha.nome,
    registroConselho: linha.registro_conselho,
    especialidade: {
      id: Number(linha.especialidade_id),
      nome: linha.especialidade_nome,
    },
    valorConsulta: Dinheiro.deCentavos(linha.valor_consulta_centavos),
    ativo: linha.ativo,
  });
}

const SELECAO = `
  SELECT p.id, p.clinica_id, p.nome, p.registro_conselho,
         p.valor_consulta_centavos, p.ativo,
         e.id AS especialidade_id, e.nome AS especialidade_nome
    FROM profissional p
    JOIN especialidade e ON e.id = p.especialidade_id
`;

class RepositorioDeProfissionaisPg extends RepositorioDeProfissionais {
  async listar({ especialidadeId = null, termo = null, limite, deslocamento }) {
    // Uma única consulta devolve a página e o total, evitando a segunda ida ao
    // banco só para contar. count(*) OVER () é avaliado sobre o conjunto
    // completo, antes do LIMIT.
    const { rows } = await consultar(
      `${SELECAO}
        WHERE p.ativo
          AND ($1::bigint IS NULL OR p.especialidade_id = $1)
          AND ($2::text IS NULL OR unaccent(p.nome) ILIKE unaccent($2))
        ORDER BY p.nome
        LIMIT $3 OFFSET $4`,
      [especialidadeId, termo ? `%${termo}%` : null, limite, deslocamento]
    );

    const { rows: contagem } = await consultar(
      `SELECT count(*)::int AS total
         FROM profissional p
        WHERE p.ativo
          AND ($1::bigint IS NULL OR p.especialidade_id = $1)
          AND ($2::text IS NULL OR unaccent(p.nome) ILIKE unaccent($2))`,
      [especialidadeId, termo ? `%${termo}%` : null]
    );

    return { itens: rows.map(paraEntidade), total: contagem[0].total };
  }

  async porId(id) {
    const { rows } = await consultar(`${SELECAO} WHERE p.id = $1`, [id]);
    return rows.length ? paraEntidade(rows[0]) : null;
  }
}

module.exports = { RepositorioDeProfissionaisPg };
