'use strict';

/**
 * Adaptador PostgreSQL para horários.
 *
 * Nesta etapa implementa apenas a leitura. `reservarEAgendar` e `liberar`
 * entram na Etapa 6, junto com o lock otimista — e é lá que a transação
 * aparece.
 */

const { RepositorioDeHorarios } = require('../../domain/repositorios');
const { Horario } = require('../../domain/Horario');
const { consultar } = require('./pool');

function paraEntidade(linha) {
  return new Horario({
    id: Number(linha.id),
    profissionalId: Number(linha.profissional_id),
    inicio: linha.inicio,
    fim: linha.fim,
    status: linha.status,
    versao: linha.versao,
  });
}

class RepositorioDeHorariosPg extends RepositorioDeHorarios {
  async porId(id) {
    const { rows } = await consultar(
      `SELECT id, profissional_id, inicio, fim, status, versao
         FROM horario
        WHERE id = $1`,
      [id]
    );
    return rows.length ? paraEntidade(rows[0]) : null;
  }

  async disponiveisDoProfissional(profissionalId, de, ate) {
    const { rows } = await consultar(
      `SELECT id, profissional_id, inicio, fim, status, versao
         FROM horario
        WHERE profissional_id = $1
          AND status = 'disponivel'
          AND inicio >= $2
          AND inicio <  $3
        ORDER BY inicio`,
      [profissionalId, de, ate]
    );
    return rows.map(paraEntidade);
  }
}

module.exports = { RepositorioDeHorariosPg };
