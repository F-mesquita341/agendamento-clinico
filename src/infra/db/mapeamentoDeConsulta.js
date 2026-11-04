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

// O nome do plano vem por subconsulta escalar, e não por JOIN: estas colunas
// servem a SELECT, a SELECT ... FOR UPDATE e a RETURNING, e só uma expressão
// por coluna funciona nos três.
const COLUNAS_DA_CONSULTA = `
  id, paciente_id, horario_id, status, valor_centavos,
  reserva_expira_em, lembrete_enviado_em, criado_em, motivo_cancelamento,
  forma_de_pagamento, plano_id,
  (SELECT pds.nome FROM plano_de_saude pds WHERE pds.id = plano_id) AS plano_nome
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
    formaDePagamento: linha.forma_de_pagamento ?? 'app',
    plano:
      linha.plano_id == null ? null : { id: Number(linha.plano_id), nome: linha.plano_nome },
  });
}

module.exports = { COLUNAS_DA_CONSULTA, paraConsulta };
