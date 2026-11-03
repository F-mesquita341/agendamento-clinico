'use strict';

const { RepositorioDePlanos } = require('../../domain/repositorios');
const { consultar } = require('./pool');

/**
 * Só os planos aceitos por ao menos um profissional ativo — pelo mesmo motivo
 * das cidades: um plano no filtro que não traz ninguém é um beco sem saída.
 */
class RepositorioDePlanosPg extends RepositorioDePlanos {
  async listar() {
    const { rows } = await consultar(
      `SELECT pds.id, pds.nome
         FROM plano_de_saude pds
        WHERE EXISTS (
                SELECT 1
                  FROM profissional_plano pp
                  JOIN profissional p ON p.id = pp.profissional_id
                 WHERE pp.plano_id = pds.id AND p.ativo
              )
        ORDER BY pds.nome`
    );
    return rows.map((r) => ({ id: Number(r.id), nome: r.nome }));
  }
}

module.exports = { RepositorioDePlanosPg };
