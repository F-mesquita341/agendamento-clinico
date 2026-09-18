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

/**
 * Neutraliza os curingas do LIKE dentro do texto buscado.
 *
 * A consulta é parametrizada, então não há injeção de SQL — mas `%` e `_` são
 * curingas do próprio operador e continuariam valendo dentro do parâmetro.
 * Sem isto, buscar por "%%" casaria com todos os profissionais, e "__" com
 * qualquer nome de duas letras ou mais: a lista voltaria cheia de gente que
 * não tem nada a ver com o que a pessoa digitou, e o total da paginação
 * refletiria o curinga, não a busca.
 *
 * A classe de caracteres cobre os três numa única passagem, então a
 * contrabarra introduzida aqui não é reprocessada.
 */
function escaparCuringas(texto) {
  return texto.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

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

const COLUNAS = `
  p.id, p.clinica_id, p.nome, p.registro_conselho,
  p.valor_consulta_centavos, p.ativo,
  e.id AS especialidade_id, e.nome AS especialidade_nome
`;

const ORIGEM = `
  FROM profissional p
  JOIN especialidade e ON e.id = p.especialidade_id
`;

// ESCAPE '\' declara explicitamente o caractere de escape usado por
// escaparCuringas acima.
const FILTRO = `
  WHERE p.ativo
    AND ($1::bigint IS NULL OR p.especialidade_id = $1)
    AND ($2::text IS NULL OR unaccent(p.nome) ILIKE unaccent($2) ESCAPE '\\')
`;

class RepositorioDeProfissionaisPg extends RepositorioDeProfissionais {
  async listar({ especialidadeId = null, termo = null, limite, deslocamento }) {
    const padrao = termo === null ? null : `%${escaparCuringas(termo)}%`;

    // count(*) OVER () é avaliado sobre o conjunto completo, antes do LIMIT:
    // a página e o total saem de uma ida só ao banco.
    const { rows } = await consultar(
      `SELECT ${COLUNAS}, count(*) OVER () AS total
       ${ORIGEM}
       ${FILTRO}
       -- p.id desempata: dois profissionais homônimos têm ordem arbitrária sob
       -- ORDER BY p.nome sozinho, e a mesma linha pode aparecer em duas páginas
       -- enquanto outra nunca aparece.
       ORDER BY p.nome, p.id
       LIMIT $3 OFFSET $4`,
      [especialidadeId, padrao, limite, deslocamento]
    );

    if (rows.length > 0) {
      return { itens: rows.map(paraEntidade), total: Number(rows[0].total) };
    }

    // Página vazia tem duas causas diferentes: ou o filtro não achou nada, ou
    // o deslocamento passou do fim do conjunto. A função de janela não devolve
    // linha alguma nos dois casos, então o total precisa de consulta própria —
    // mas só quando o deslocamento não é zero, que é o único caso em que o
    // total pode ser diferente de zero.
    if (deslocamento === 0) {
      return { itens: [], total: 0 };
    }

    const { rows: contagem } = await consultar(
      `SELECT count(*)::int AS total ${ORIGEM} ${FILTRO}`,
      [especialidadeId, padrao]
    );
    return { itens: [], total: contagem[0].total };
  }

  async porId(id) {
    const { rows } = await consultar(
      `SELECT ${COLUNAS} ${ORIGEM} WHERE p.id = $1`,
      [id]
    );
    return rows.length ? paraEntidade(rows[0]) : null;
  }
}

// `paraEntidade` sai daqui como `paraProfissional` porque o adaptador de
// consultas monta profissional a partir do mesmo JOIN: a tradução precisa ser
// literalmente a mesma nos dois lugares.
module.exports = {
  RepositorioDeProfissionaisPg,
  escaparCuringas,
  paraProfissional: paraEntidade,
};
