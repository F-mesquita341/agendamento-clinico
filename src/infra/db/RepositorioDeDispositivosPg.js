'use strict';

/**
 * Adaptador PostgreSQL para os aparelhos que recebem notificação.
 *
 * Nenhum token vai para log ou auditoria aqui — ver o comentário na
 * migration 009. O que sai deste arquivo para o resto do sistema são tokens
 * para enviar e contagens para registrar.
 */

const { RepositorioDeDispositivos } = require('../../domain/repositorios');
const { consultar } = require('./pool');

class RepositorioDeDispositivosPg extends RepositorioDeDispositivos {
  /**
   * Registrar é idempotente por token, e não por (paciente, token).
   *
   * Se o aparelho já estava registrado para OUTRA conta, ele passa a ser desta:
   * é o caso de alguém sair do aplicativo e outra pessoa entrar no mesmo
   * telefone. Sem a reatribuição, o dono anterior continuaria recebendo, ali,
   * o lembrete das consultas dele.
   */
  async registrar({ pacienteId, token, plataforma }) {
    await consultar(
      `INSERT INTO dispositivo (paciente_id, token, plataforma)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE
         SET paciente_id = EXCLUDED.paciente_id,
             plataforma = EXCLUDED.plataforma,
             atualizado_em = now()`,
      [pacienteId, token, plataforma]
    );
  }

  /** Só remove o que é do próprio paciente. */
  async revogar(pacienteId, token) {
    const { rowCount } = await consultar(
      'DELETE FROM dispositivo WHERE paciente_id = $1 AND token = $2',
      [pacienteId, token]
    );
    return rowCount > 0;
  }

  async doPaciente(pacienteId) {
    const { rows } = await consultar(
      'SELECT token FROM dispositivo WHERE paciente_id = $1 ORDER BY id',
      [pacienteId]
    );
    return rows.map((linha) => linha.token);
  }

  async esquecer(tokens) {
    if (!tokens || tokens.length === 0) return 0;
    const { rowCount } = await consultar('DELETE FROM dispositivo WHERE token = ANY($1)', [tokens]);
    return rowCount;
  }
}

module.exports = { RepositorioDeDispositivosPg };
