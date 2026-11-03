'use strict';

/**
 * A agenda que os seeds criam: de amanhã até o último dia do período,
 * inclusive; seg a sex, 08:00–11:30 e 14:00–17:30, em blocos de 30 minutos, no
 * fuso de Fortaleza. As duas datas vêm de periodoDoSeed.js, já no fuso da
 * clínica. Horário que já existe fica como está — reservado ou não —, e
 * consulta não é tocada.
 *
 * Um módulo só, usado pelo seed e pelo seed de demonstração da versão 2, para
 * a grade dos dois ser exatamente a mesma.
 *
 * @param {(sql: string, valores?: any[]) => Promise<{rowCount: number}>} consultar
 * @param {{hoje: string, ultimoDia: string}} periodo
 * @returns {Promise<number>} quantos horários foram criados
 */
async function criarGrade(consultar, { hoje, ultimoDia }) {
  const { rowCount } = await consultar(
    `
    INSERT INTO horario (profissional_id, inicio, fim)
    SELECT p.id,
           (s.momento AT TIME ZONE 'America/Fortaleza'),
           (s.momento AT TIME ZONE 'America/Fortaleza') + INTERVAL '30 minutes'
      FROM profissional p
      CROSS JOIN LATERAL (
        SELECT gs AS momento
          FROM generate_series(
                 ($1::date + 1)::timestamp,
                 ($2::date + 1)::timestamp,
                 INTERVAL '30 minutes'
               ) gs
         WHERE EXTRACT(dow FROM gs) BETWEEN 1 AND 5
           AND (
             (gs::time >= TIME '08:00' AND gs::time < TIME '11:30') OR
             (gs::time >= TIME '14:00' AND gs::time < TIME '17:30')
           )
      ) s
     WHERE p.ativo
    ON CONFLICT (profissional_id, inicio) DO NOTHING;
  `,
    [hoje, ultimoDia]
  );
  return rowCount;
}

module.exports = { criarGrade };
