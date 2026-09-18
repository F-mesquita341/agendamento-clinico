'use strict';

/**
 * Adaptador PostgreSQL para horários.
 *
 * Aqui mora o lock otimista (Optimistic Offline Lock, FOWLER, 2006), que é o
 * mecanismo central do trabalho. A comparação de versão e a criação da consulta
 * acontecem dentro de UMA transação: ou as duas valem, ou nenhuma.
 */

const { RepositorioDeHorarios } = require('../../domain/repositorios');
const { Horario } = require('../../domain/Horario');
const { RegraDeNegocio, ConsultaSobreposta } = require('../../domain/erros');
const { pool, consultar, transacao } = require('./pool');
const { COLUNAS_DA_CONSULTA, paraConsulta } = require('./mapeamentoDeConsulta');

const COLUNAS = 'id, profissional_id, inicio, fim, status, versao';

function paraHorario(linha) {
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
      `SELECT ${COLUNAS} FROM horario WHERE id = $1`,
      [id]
    );
    return rows.length ? paraHorario(rows[0]) : null;
  }

  async disponiveisDoProfissional(profissionalId, de, ate) {
    const { rows } = await consultar(
      `SELECT ${COLUNAS}
         FROM horario
        WHERE profissional_id = $1
          AND status = 'disponivel'
          AND inicio >= $2
          AND inicio <  $3
        ORDER BY inicio`,
      [profissionalId, de, ate]
    );
    return rows.map(paraHorario);
  }

  /**
   * Reserva o horário e cria a consulta, atomicamente.
   *
   * O UPDATE é o lock otimista inteiro. Sob concorrência, a segunda transação
   * fica bloqueada na linha até a primeira confirmar; quando o bloqueio sai, o
   * PostgreSQL reavalia o WHERE sobre a linha já atualizada, `versao` não
   * confere mais, e o UPDATE não alcança nenhuma linha. Nada de "ler, decidir,
   * escrever" — a decisão é a própria escrita.
   *
   * @returns {Promise<import('../../domain/Consulta').Consulta|null>} `null`
   *          quando a versão não conferia: outra pessoa chegou antes.
   */
  async reservarEAgendar({ horarioId, versao, pacienteId, reservaExpiraEm }) {
    return transacao(async (cliente) => {
      const reserva = await cliente.query(
        `UPDATE horario
            SET status = 'reservado', versao = versao + 1
          WHERE id = $1 AND versao = $2 AND status = 'disponivel'
          RETURNING profissional_id, versao, inicio, fim`,
        [horarioId, versao]
      );

      if (reserva.rowCount === 0) {
        return null;
      }

      const {
        profissional_id: profissionalId,
        versao: versaoNova,
        inicio,
        fim,
      } = reserva.rows[0];

      // O preço é lido AQUI, dentro da transação, e congelado na consulta: ele
      // é atributo do profissional, e um reajuste amanhã não pode alterar o
      // valor de uma consulta marcada hoje.
      const { rows: profissionais } = await cliente.query(
        'SELECT valor_consulta_centavos, ativo FROM profissional WHERE id = $1',
        [profissionalId]
      );

      // Desativar um profissional tira os horários dele das listagens, mas um
      // aplicativo com a tela antiga aberta ainda tentaria agendar. O ROLLBACK
      // desfaz a reserva feita acima.
      if (!profissionais[0]?.ativo) {
        throw new RegraDeNegocio(
          'PROFISSIONAL_INDISPONIVEL',
          'Este profissional não está mais atendendo. Escolha outro horário.'
        );
      }

      let linha;
      try {
        const { rows } = await cliente.query(
          `INSERT INTO consulta
             (paciente_id, horario_id, status, valor_centavos, reserva_expira_em, periodo)
           VALUES ($1, $2, 'pendente_pagamento', $3, $4, tstzrange($5, $6, '[)'))
           RETURNING ${COLUNAS_DA_CONSULTA}`,
          [
            pacienteId,
            horarioId,
            profissionais[0].valor_consulta_centavos,
            reservaExpiraEm,
            // O período é copiado do horário reservado logo acima, e congela a
            // duração combinada junto com o preço.
            inicio,
            fim,
          ]
        );
        linha = rows[0];
      } catch (erro) {
        // A agenda do paciente já tem consulta ativa colidindo com este
        // intervalo. A checagem prévia do caso de uso não pega quando os dois
        // pedidos chegam juntos — ver migration 007.
        if (erro.code === '23P01' && erro.constraint === 'consulta_sem_sobreposicao') {
          throw new ConsultaSobreposta();
        }
        // A rede de segurança do banco disparou: já existe consulta ativa neste
        // horário, embora ele estivesse marcado como disponível. Para o paciente
        // é a mesma coisa que perder a disputa (409), mas para nós é sinal de
        // estado inconsistente — e some do radar se não for registrado.
        if (erro.code === '23505' && erro.constraint === 'consulta_horario_ativo') {
          console.warn(
            `Índice consulta_horario_ativo impediu agendar no horário ${horarioId}: ` +
              'existe consulta ativa em horário marcado como disponível.'
          );
          return null;
        }
        throw erro;
      }

      await cliente.query(
        `INSERT INTO auditoria (ator_tipo, ator_id, acao, entidade, entidade_id, detalhe)
         VALUES ('paciente', $1, 'consulta.criada', 'consulta', $2, $3)`,
        // Só identificadores e a versão resultante. Especialidade, nome do
        // profissional e motivo da consulta são dado de saúde e não entram aqui.
        [pacienteId, linha.id, { horarioId: Number(horarioId), versaoDoHorario: versaoNova }]
      );

      return paraConsulta(linha);
    });
  }

  /**
   * Devolve o horário à grade, incrementando a versão.
   *
   * Aceita um `executor` para rodar dentro de uma transação já aberta — é assim
   * que o cancelamento libera o horário junto com a mudança de estado da
   * consulta. Sem argumento, usa o pool: é como a rotina de expiração de
   * reservas não pagas vai chamá-lo.
   *
   * Só libera horário `reservado`: um horário que a clínica bloqueou continua
   * bloqueado mesmo que uma consulta antiga seja cancelada.
   *
   * @returns {Promise<boolean>} se o horário voltou para a grade.
   */
  async liberar(horarioId, executor = pool) {
    const { rowCount } = await executor.query(
      `UPDATE horario
          SET status = 'disponivel', versao = versao + 1
        WHERE id = $1 AND status = 'reservado'`,
      [horarioId]
    );
    return rowCount === 1;
  }
}

module.exports = { RepositorioDeHorariosPg, paraHorario };
