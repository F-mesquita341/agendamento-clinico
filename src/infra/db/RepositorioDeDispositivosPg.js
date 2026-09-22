'use strict';

/**
 * Adaptador PostgreSQL para os aparelhos que recebem notificação.
 *
 * Nenhum token vai para log ou auditoria aqui — ver o comentário na
 * migration 009. O que sai deste arquivo para o resto do sistema são tokens
 * para enviar, ids e contagens.
 */

const { RepositorioDeDispositivos } = require('../../domain/repositorios');
const { consultar, transacao } = require('./pool');
const { auditar } = require('./auditoria');

class RepositorioDeDispositivosPg extends RepositorioDeDispositivos {
  /**
   * Registrar é idempotente por token, e não por (paciente, token).
   *
   * Se o aparelho já estava registrado para OUTRA conta, ele passa a ser desta:
   * é o caso de alguém sair do aplicativo e outra pessoa entrar no mesmo
   * telefone. Sem a reatribuição, o dono anterior continuaria recebendo, ali,
   * o lembrete das consultas dele.
   *
   * A reatribuição é justamente um evento de privacidade, então entra na
   * auditoria — com os dois pacientes envolvidos e nunca com o token. O
   * registro repetido do próprio aparelho não entra: o aplicativo registra a
   * cada abertura, e a auditoria viraria ruído.
   */
  async registrar({ pacienteId, token, plataforma }) {
    return transacao(async (cliente) => {
      // O dono anterior sai da mesma instrução, pela CTE. Ela enxerga o banco
      // como estava no começo da instrução — então dois registros SIMULTÂNEOS
      // do mesmo token podem ambos ver "não havia dono" e auditar o registro
      // duas vezes. O estado final é o certo (uma linha, do último), e a linha
      // repetida na auditoria é inofensiva; fechar isso exigiria bloqueio
      // explícito por um caso que o aplicativo não produz.
      const { rows } = await cliente.query(
        `WITH anterior AS (SELECT paciente_id FROM dispositivo WHERE token = $2)
         INSERT INTO dispositivo (paciente_id, token, plataforma)
         VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE
           SET paciente_id = EXCLUDED.paciente_id,
               plataforma = EXCLUDED.plataforma,
               atualizado_em = now()
         RETURNING id, (SELECT paciente_id FROM anterior) AS dono_anterior`,
        [pacienteId, token, plataforma]
      );

      const id = Number(rows[0].id);
      const donoAnterior = rows[0].dono_anterior === null ? null : Number(rows[0].dono_anterior);

      if (donoAnterior === null) {
        await auditar(cliente, {
          atorTipo: 'paciente',
          atorId: pacienteId,
          acao: 'dispositivo.registrado',
          entidade: 'dispositivo',
          entidadeId: id,
          detalhe: { plataforma },
        });
      } else if (donoAnterior !== Number(pacienteId)) {
        await auditar(cliente, {
          atorTipo: 'paciente',
          atorId: pacienteId,
          acao: 'dispositivo.reatribuido',
          entidade: 'dispositivo',
          entidadeId: id,
          detalhe: { donoAnterior, plataforma },
        });
      }

      return { id };
    });
  }

  /** Só remove o que é do próprio paciente. */
  async revogar(pacienteId, dispositivoId) {
    return transacao(async (cliente) => {
      const { rowCount } = await cliente.query(
        'DELETE FROM dispositivo WHERE id = $1 AND paciente_id = $2',
        [dispositivoId, pacienteId]
      );
      if (rowCount === 0) return false;

      await auditar(cliente, {
        atorTipo: 'paciente',
        atorId: pacienteId,
        acao: 'dispositivo.revogado',
        entidade: 'dispositivo',
        entidadeId: dispositivoId,
        detalhe: null,
      });
      return true;
    });
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
