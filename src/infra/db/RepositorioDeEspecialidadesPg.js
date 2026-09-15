'use strict';

const { RepositorioDeEspecialidades } = require('../../domain/repositorios');
const { consultar } = require('./pool');

class RepositorioDeEspecialidadesPg extends RepositorioDeEspecialidades {
  async listar() {
    const { rows } = await consultar(
      `SELECT id, nome
         FROM especialidade
        ORDER BY nome`
    );
    // id vem como string do driver quando a coluna é BIGINT; o JavaScript
    // não representa BIGINT com segurança em number, mas os ids deste
    // sistema estão muito abaixo do limite, então a conversão é segura.
    return rows.map((r) => ({ id: Number(r.id), nome: r.nome }));
  }
}

module.exports = { RepositorioDeEspecialidadesPg };
