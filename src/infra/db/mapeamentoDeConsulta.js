'use strict';

/**
 * Tradução de linha de `consulta` para a entidade do domínio.
 *
 * Fica em arquivo próprio porque DOIS adaptadores produzem consultas: o de
 * horários, ao reservar e agendar na mesma transação, e o de consultas, nas
 * leituras e no cancelamento. Duplicar esta tradução abriria espaço para os
 * dois divergirem — e um deles esquecer o valor, por exemplo, só apareceria
 * em produção.
 */

const { Consulta } = require('../../domain/Consulta');

const COLUNAS_DA_CONSULTA = `
  id, paciente_id, horario_id, status, valor_centavos,
  reserva_expira_em, lembrete_enviado_em, criado_em, motivo_cancelamento
`;

function paraConsulta(linha) {
  return new Consulta({
    id: Number(linha.id),
    pacienteId: Number(linha.paciente_id),
    horarioId: Number(linha.horario_id),
    status: linha.status,
    // A coluna é INTEGER em centavos; a entidade embrulha em Dinheiro.
    valor: Number(linha.valor_centavos),
    reservaExpiraEm: linha.reserva_expira_em,
    lembreteEnviadoEm: linha.lembrete_enviado_em,
    criadoEm: linha.criado_em,
    motivoCancelamento: linha.motivo_cancelamento ?? null,
  });
}

module.exports = { COLUNAS_DA_CONSULTA, paraConsulta };
