'use strict';

const { RepositorioDeCidades } = require('../../domain/repositorios');
const { consultar } = require('./pool');

/**
 * Só as cidades com ao menos um profissional ativo numa clínica delas: a lista
 * de escolha do aplicativo não pode oferecer uma cidade cuja busca vem vazia.
 */
class RepositorioDeCidadesPg extends RepositorioDeCidades {
  async listar() {
    const { rows } = await consultar(
      `SELECT ci.id, ci.nome, ci.uf
         FROM cidade ci
        WHERE EXISTS (
                SELECT 1
                  FROM clinica cl
                  JOIN profissional p ON p.clinica_id = cl.id
                 WHERE cl.cidade_id = ci.id AND p.ativo
              )
        ORDER BY ci.nome, ci.uf`
    );
    return rows.map((r) => ({ id: Number(r.id), nome: r.nome, uf: r.uf }));
  }
}

module.exports = { RepositorioDeCidadesPg };
