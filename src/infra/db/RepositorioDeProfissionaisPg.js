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

/** `{ id, inicio }`, null, ou undefined quando a leitura não o calculou. */
function proximoHorarioDa(linha) {
  if (!('proximo_horario_id' in linha)) return undefined;
  if (linha.proximo_horario_id === null) return null;
  return { id: Number(linha.proximo_horario_id), inicio: new Date(linha.proximo_horario_inicio) };
}

function paraEntidade(linha) {
  return new Profissional({
    id: Number(linha.id),
    clinicaId: Number(linha.clinica_id),
    clinica: {
      id: Number(linha.clinica_id),
      nome: linha.clinica_nome,
      telefone: linha.clinica_telefone ?? null,
      endereco: linha.clinica_endereco ?? null,
      cidade:
        linha.clinica_cidade_id == null
          ? null
          : {
              id: Number(linha.clinica_cidade_id),
              nome: linha.clinica_cidade_nome,
              uf: linha.clinica_cidade_uf,
            },
      latitude: linha.clinica_latitude ?? null,
      longitude: linha.clinica_longitude ?? null,
    },
    nome: linha.nome,
    registroConselho: linha.registro_conselho,
    especialidade: {
      id: Number(linha.especialidade_id),
      nome: linha.especialidade_nome,
    },
    valorConsulta: Dinheiro.deCentavos(linha.valor_consulta_centavos),
    ativo: linha.ativo,
    aceitaPagamentoNoApp: linha.aceita_pagamento_no_app ?? true,
    aceitaPagarNaClinica: linha.aceita_pagar_na_clinica ?? false,
    // Só as leituras do catálogo trazem a coluna; a de consultas, não — e aí
    // os planos ficam "não lidos", e não "nenhum".
    planos:
      'planos' in linha
        ? linha.planos.map((plano) => ({ id: Number(plano.id), nome: plano.nome }))
        : undefined,
    proximoHorario: proximoHorarioDa(linha),
  });
}

const COLUNAS = `
  p.id, p.clinica_id, p.nome, p.registro_conselho,
  p.valor_consulta_centavos, p.ativo,
  p.aceita_pagamento_no_app, p.aceita_pagar_na_clinica,
  e.id AS especialidade_id, e.nome AS especialidade_nome,
  cl.nome AS clinica_nome, cl.telefone AS clinica_telefone, cl.endereco AS clinica_endereco,
  cl.latitude AS clinica_latitude, cl.longitude AS clinica_longitude,
  ci.id AS clinica_cidade_id, ci.nome AS clinica_cidade_nome, ci.uf AS clinica_cidade_uf,
  pl.planos,
  ph.id AS proximo_horario_id, ph.inicio AS proximo_horario_inicio
`;

// JOIN comum com a clínica, e não LEFT JOIN: `profissional.clinica_id` é
// obrigatório e tem chave estrangeira, então toda linha encontra a sua, e a
// contagem e a paginação não mudam. O CNPJ não é selecionado: o app não usa.
// Alias `cl`, porque na leitura de consultas `c` já é a consulta. A cidade é
// LEFT JOIN: clínica sem cidade cadastrada continua aparecendo.
const ORIGEM = `
  FROM profissional p
  JOIN especialidade e ON e.id = p.especialidade_id
  JOIN clinica cl      ON cl.id = p.clinica_id
  LEFT JOIN cidade ci  ON ci.id = cl.cidade_id
`;

// Os planos e o próximo horário vêm de subconsultas LATERAL, uma linha por
// profissional. Um JOIN com os planos repetiria o profissional uma vez por
// plano: a lista mostraria o mesmo nome três vezes e o count(*) OVER () da
// paginação contaria três. Ficam fora da ORIGEM porque a contagem da página
// vazia não precisa deles.
const LATERAIS = `
  CROSS JOIN LATERAL (
    SELECT COALESCE(
             json_agg(json_build_object('id', pds.id, 'nome', pds.nome)
                      ORDER BY pds.nome, pds.id),
             '[]'::json
           ) AS planos
      FROM profissional_plano pp
      JOIN plano_de_saude pds ON pds.id = pp.plano_id
     WHERE pp.profissional_id = p.id
  ) pl
  -- O horário livre mais cedo que ainda não começou — o mesmo critério da
  -- grade (GET /profissionais/:id/horarios). O índice único
  -- (profissional_id, inicio) atende ao ORDER BY ... LIMIT 1.
  LEFT JOIN LATERAL (
    SELECT h.id, h.inicio
      FROM horario h
     WHERE h.profissional_id = p.id
       AND h.status = 'disponivel'
       AND h.inicio > now()
     ORDER BY h.inicio
     LIMIT 1
  ) ph ON true
`;

// ESCAPE '\' declara explicitamente o caractere de escape usado por
// escaparCuringas acima. O plano é EXISTS, e não JOIN, pelo mesmo motivo dos
// LATERAL: filtrar não pode multiplicar as linhas.
const FILTRO = `
  WHERE p.ativo
    AND ($1::bigint IS NULL OR p.especialidade_id = $1)
    AND ($2::text IS NULL OR unaccent(p.nome) ILIKE unaccent($2) ESCAPE '\\')
    AND ($3::bigint IS NULL OR cl.cidade_id = $3)
    AND ($4::bigint IS NULL OR EXISTS (
          SELECT 1 FROM profissional_plano fpp
           WHERE fpp.profissional_id = p.id AND fpp.plano_id = $4))
`;

class RepositorioDeProfissionaisPg extends RepositorioDeProfissionais {
  async listar({
    especialidadeId = null,
    termo = null,
    cidadeId = null,
    planoId = null,
    limite,
    deslocamento,
  }) {
    const padrao = termo === null ? null : `%${escaparCuringas(termo)}%`;
    const filtros = [especialidadeId, padrao, cidadeId, planoId];

    // count(*) OVER () é avaliado sobre o conjunto completo, antes do LIMIT:
    // a página e o total saem de uma ida só ao banco.
    const { rows } = await consultar(
      `SELECT ${COLUNAS}, count(*) OVER () AS total
       ${ORIGEM}
       ${LATERAIS}
       ${FILTRO}
       -- p.id desempata: dois profissionais homônimos têm ordem arbitrária sob
       -- ORDER BY p.nome sozinho, e a mesma linha pode aparecer em duas páginas
       -- enquanto outra nunca aparece.
       ORDER BY p.nome, p.id
       LIMIT $5 OFFSET $6`,
      [...filtros, limite, deslocamento]
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
      filtros
    );
    return { itens: [], total: contagem[0].total };
  }

  async porId(id) {
    const { rows } = await consultar(
      `SELECT ${COLUNAS} ${ORIGEM} ${LATERAIS} WHERE p.id = $1`,
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
