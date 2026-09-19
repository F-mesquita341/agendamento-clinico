'use strict';

/**
 * Adaptador PostgreSQL para consultas.
 *
 * Duas responsabilidades bem diferentes:
 *
 *   - leitura para as telas do aplicativo, que precisa da consulta JUNTO com o
 *     horário e o profissional — daí o JOIN, em vez de uma requisição por item;
 *   - cancelamento, que muda o estado da consulta e devolve o horário à grade
 *     na mesma transação.
 */

const { RepositorioDeConsultas } = require('../../domain/repositorios');
const { NaoEncontrado } = require('../../domain/erros');
const { MOTIVO_CANCELAMENTO } = require('../../domain/Consulta');
const { consultar, transacao } = require('./pool');
const { COLUNAS_DA_CONSULTA, paraConsulta } = require('./mapeamentoDeConsulta');
const { RepositorioDeHorariosPg, paraHorario } = require('./RepositorioDeHorariosPg');
const { paraProfissional } = require('./RepositorioDeProfissionaisPg');

/**
 * Colunas das três tabelas num SELECT só.
 *
 * Os prefixos existem porque `id`, `nome` e `status` se repetem entre elas, e
 * o driver devolve um objeto plano: sem prefixo, a última coluna homônima
 * sobrescreveria as anteriores em silêncio.
 */
const COLUNAS_DA_LEITURA = `
  c.id, c.paciente_id, c.horario_id, c.status, c.valor_centavos,
  c.reserva_expira_em, c.lembrete_enviado_em, c.criado_em, c.motivo_cancelamento,

  h.id AS h_id, h.profissional_id AS h_profissional_id,
  h.inicio AS h_inicio, h.fim AS h_fim,
  h.status AS h_status, h.versao AS h_versao,

  p.id AS p_id, p.clinica_id AS p_clinica_id, p.nome AS p_nome,
  p.registro_conselho AS p_registro_conselho,
  p.valor_consulta_centavos AS p_valor_consulta_centavos, p.ativo AS p_ativo,
  e.id AS p_especialidade_id, e.nome AS p_especialidade_nome
`;

const ORIGEM_DA_LEITURA = `
  FROM consulta c
  JOIN horario h       ON h.id = c.horario_id
  JOIN profissional p  ON p.id = h.profissional_id
  JOIN especialidade e ON e.id = p.especialidade_id
`;

/** Recorta as colunas de um prefixo e devolve os nomes originais. */
function semPrefixo(linha, prefixo) {
  return Object.fromEntries(
    Object.entries(linha)
      .filter(([coluna]) => coluna.startsWith(prefixo))
      .map(([coluna, valor]) => [coluna.slice(prefixo.length), valor])
  );
}

/**
 * Leitura composta: `{ consulta, horario, profissional }`.
 *
 * A tradução de cada parte é a mesma dos outros adaptadores, reaproveitada —
 * o horário montado aqui precisa ser idêntico ao que a grade devolve.
 */
function paraLeitura(linha) {
  return {
    consulta: paraConsulta(linha),
    horario: paraHorario(semPrefixo(linha, 'h_')),
    profissional: paraProfissional(semPrefixo(linha, 'p_')),
  };
}

const horarios = new RepositorioDeHorariosPg();

class RepositorioDeConsultasPg extends RepositorioDeConsultas {
  async porId(id) {
    const { rows } = await consultar(
      `SELECT ${COLUNAS_DA_CONSULTA} FROM consulta WHERE id = $1`,
      [id]
    );
    return rows.length ? paraConsulta(rows[0]) : null;
  }

  async leituraPorId(id) {
    const { rows } = await consultar(
      `SELECT ${COLUNAS_DA_LEITURA} ${ORIGEM_DA_LEITURA} WHERE c.id = $1`,
      [id]
    );
    return rows.length ? paraLeitura(rows[0]) : null;
  }

  async doPaciente({ pacienteId, limite, deslocamento }) {
    // count(*) OVER () traz o total do conjunto completo junto com a página,
    // numa ida só — o mesmo recurso usado na busca de profissionais.
    const { rows } = await consultar(
      `SELECT ${COLUNAS_DA_LEITURA}, count(*) OVER () AS total
       ${ORIGEM_DA_LEITURA}
       WHERE c.paciente_id = $1
       ORDER BY h.inicio DESC, c.id DESC
       LIMIT $2 OFFSET $3`,
      [pacienteId, limite, deslocamento]
    );

    if (rows.length > 0) {
      return { itens: rows.map(paraLeitura), total: Number(rows[0].total) };
    }

    // Página vazia não distingue "não tem nenhuma" de "o deslocamento passou do
    // fim". A função de janela não devolve linha em nenhum dos dois casos, então
    // o total precisa de uma consulta própria.
    const { rows: contagem } = await consultar(
      'SELECT count(*)::int AS total FROM consulta WHERE paciente_id = $1',
      [pacienteId]
    );
    return { itens: [], total: contagem[0].total };
  }

  async existeAtivaNoIntervalo(pacienteId, inicio, fim) {
    const { rowCount } = await consultar(
      `SELECT 1
         FROM consulta c
         JOIN horario h ON h.id = c.horario_id
        WHERE c.paciente_id = $1
          AND c.status <> 'cancelada'
          -- Sobreposição: começa antes de o outro terminar e termina depois de
          -- ele começar. Encostar não é sobrepor.
          AND h.inicio < $3
          AND h.fim    > $2
        LIMIT 1`,
      [pacienteId, inicio, fim]
    );
    return rowCount > 0;
  }

  /**
   * Cancela e devolve o horário à grade, na mesma transação.
   *
   * O `FOR UPDATE` é o que impede o cancelamento repetido de fazer estrago: o
   * segundo pedido espera o primeiro terminar, relê a linha já cancelada e é
   * recusado pelo domínio. Sem ele, os dois passariam, o horário seria liberado
   * duas vezes e o segundo `liberar` poderia tirar da grade — ou melhor, colocar
   * de volta na grade — um horário que outra pessoa já teria reservado.
   *
   * Ordem dos bloqueios: consulta e depois horário. O agendamento trava o
   * horário primeiro, mas só consegue travá-lo quando ele está disponível —
   * situação em que não há consulta ativa para disputar.
   */
  async cancelar(consultaId) {
    return transacao(async (cliente) => {
      const consulta = await lerSobBloqueio(cliente, consultaId);
      if (!consulta) {
        throw new NaoEncontrado('Consulta');
      }

      // Relido sob bloqueio: entre a verificação do caso de uso e este ponto o
      // estado pode ter mudado. Quem decide continua sendo o domínio.
      consulta.garantirQuePodeSerCancelada();

      return cancelarSobBloqueio(cliente, consulta, {
        motivo: MOTIVO_CANCELAMENTO.PACIENTE,
        atorTipo: 'paciente',
        atorId: consulta.pacienteId,
        acao: 'consulta.cancelada',
      });
    });
  }

  async reservasVencidas(agora, limite) {
    // Sem bloqueio: é só a lista de candidatas. A reconciliação pergunta ao
    // provedor FORA de qualquer transação — segurar bloqueio esperando rede
    // travaria o agendamento — e a decisão final é refeita sob bloqueio.
    const { rows } = await consultar(
      `SELECT c.id, c.reserva_expira_em,
              COALESCE(
                array_agg(DISTINCT p.referencia_externa)
                  FILTER (WHERE p.referencia_externa IS NOT NULL),
                '{}'
              ) AS referencias
         FROM consulta c
         LEFT JOIN pagamento p ON p.consulta_id = c.id
        WHERE c.status = 'pendente_pagamento'
          AND c.reserva_expira_em <= $1
        GROUP BY c.id, c.reserva_expira_em
        ORDER BY c.reserva_expira_em
        LIMIT $2`,
      [agora, limite]
    );
    return rows.map((linha) => ({
      consultaId: Number(linha.id),
      reservaExpiraEm: linha.reserva_expira_em,
      referencias: linha.referencias,
    }));
  }

  async expirarSeVencida(consultaId, agora) {
    return transacao(async (cliente) => {
      const consulta = await lerSobBloqueio(cliente, consultaId);
      // Um pagamento pode tê-la confirmado entre a varredura e este bloqueio —
      // o webhook trava a mesma linha. Quem chegar depois encontra o estado
      // novo e respeita.
      if (!consulta || !consulta.expirouAguardandoPagamento(agora)) {
        return false;
      }

      await cancelarSobBloqueio(cliente, consulta, {
        motivo: MOTIVO_CANCELAMENTO.RESERVA_EXPIRADA,
        atorTipo: 'sistema',
        atorId: null,
        acao: 'consulta.expirada',
      });
      return true;
    });
  }
}

async function lerSobBloqueio(cliente, consultaId) {
  const { rows } = await cliente.query(
    `SELECT ${COLUNAS_DA_CONSULTA} FROM consulta WHERE id = $1 FOR UPDATE`,
    [consultaId]
  );
  return rows.length ? paraConsulta(rows[0]) : null;
}

/**
 * O que cancelar significa, venha o pedido do paciente ou da rotina de
 * expiração: estado e motivo numa só escrita — o banco exige motivo em toda
 * consulta cancelada —, horário de volta à grade, checkout aberto encerrado e
 * auditoria. Tudo dentro da transação de quem chamou, com a consulta já
 * bloqueada.
 *
 * Encerrar o checkout importa: sem isso, o paciente ainda poderia pagar pela
 * página do provedor uma consulta que já não existe.
 */
async function cancelarSobBloqueio(cliente, consulta, { motivo, atorTipo, atorId, acao }) {
  const { rows } = await cliente.query(
    `UPDATE consulta
        SET status = 'cancelada', motivo_cancelamento = $2, atualizado_em = now()
      WHERE id = $1
      RETURNING ${COLUNAS_DA_CONSULTA}`,
    [consulta.id, motivo]
  );

  const liberado = await horarios.liberar(consulta.horarioId, cliente);
  if (!liberado) {
    // Consulta ativa cujo horário não estava reservado: inconsistência que
    // não impede o cancelamento, mas precisa aparecer no log.
    console.warn(
      `Consulta ${consulta.id} cancelada, mas o horário ${consulta.horarioId} ` +
        'não estava reservado.'
    );
  }

  await cliente.query(
    `UPDATE pagamento
        SET status = 'expirado', atualizado_em = now()
      WHERE consulta_id = $1 AND status = 'pendente' AND pagamento_externo_id IS NULL`,
    [consulta.id]
  );

  await cliente.query(
    `INSERT INTO auditoria (ator_tipo, ator_id, acao, entidade, entidade_id, detalhe)
     VALUES ($1, $2, $3, 'consulta', $4, $5)`,
    [atorTipo, atorId, acao, consulta.id, { horarioId: consulta.horarioId, horarioLiberado: liberado }]
  );

  return paraConsulta(rows[0]);
}

module.exports = { RepositorioDeConsultasPg };
