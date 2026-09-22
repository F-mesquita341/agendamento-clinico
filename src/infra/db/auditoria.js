'use strict';

/**
 * Uma linha de auditoria.
 *
 * Extraída de RepositorioDePagamentosPg.js, onde era privada, quando a Etapa 9
 * precisou dela em mais dois adaptadores. A lista de colunas da tabela já
 * aparecia escrita à mão em vários lugares; cada cópia nova é mais um ponto a
 * acertar se a tabela mudar.
 *
 * `executor` é qualquer coisa com `.query` — o cliente de uma transação em
 * andamento, para a auditoria cair junto com a mudança que ela registra, ou o
 * pool, quando não há transação.
 *
 * O `detalhe` nunca leva dado pessoal nem identificador de aparelho: ids
 * internos, contagens, estados.
 */

async function auditar(executor, { atorTipo, atorId = null, acao, entidade, entidadeId, detalhe }) {
  await executor.query(
    `INSERT INTO auditoria (ator_tipo, ator_id, acao, entidade, entidade_id, detalhe)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [atorTipo, atorId, acao, entidade, entidadeId, detalhe]
  );
}

module.exports = { auditar };
