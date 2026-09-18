'use strict';

/**
 * A agenda do paciente não pode ter duas consultas ao mesmo tempo — garantido
 * pelo banco, e não só pela aplicação.
 *
 * `AgendarConsulta` já verificava sobreposição antes de gravar, mas essa
 * verificação é uma LEITURA fora da transação: dois pedidos simultâneos para
 * horários diferentes e sobrepostos passam juntos por ela, cada um reserva a
 * sua própria linha de `horario` — versões distintas, nenhuma chave em comum —
 * e as duas consultas nascem. O índice `consulta_horario_ativo` não pega, porque
 * ele é por `horario_id`, e os horários são outros.
 *
 * É o mesmo raciocínio da migration 002: a checagem da aplicação existe para dar
 * mensagem boa no caso comum; quem garante exclusividade é o banco.
 *
 * Por que uma coluna `periodo` em vez de olhar `horario` na hora: uma restrição
 * de exclusão só enxerga a própria tabela. O período é copiado do horário no
 * instante do agendamento — o que também congela a duração combinada, do mesmo
 * jeito que `valor_centavos` congela o preço.
 *
 * O intervalo é semiaberto `[)`, idêntico à comparação usada na aplicação
 * (`inicio < fim_do_outro AND fim > inicio_do_outro`): uma consulta que termina
 * 10:30 não conflita com outra que começa 10:30.
 *
 * A cláusula WHERE torna a restrição PARCIAL, pela mesma razão do índice de
 * horário: consulta cancelada continua na tabela, para histórico e para a
 * análise de absenteísmo, e não pode bloquear um novo agendamento.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Permite combinar igualdade (paciente_id) com sobreposição (&&) numa
    -- mesma restrição de exclusão.
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    ALTER TABLE consulta ADD COLUMN periodo tstzrange;

    UPDATE consulta c
       SET periodo = tstzrange(h.inicio, h.fim, '[)')
      FROM horario h
     WHERE h.id = c.horario_id;

    ALTER TABLE consulta ALTER COLUMN periodo SET NOT NULL;

    ALTER TABLE consulta
      ADD CONSTRAINT consulta_sem_sobreposicao
      EXCLUDE USING gist (paciente_id WITH =, periodo WITH &&)
      WHERE (status <> 'cancelada');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE consulta DROP CONSTRAINT IF EXISTS consulta_sem_sobreposicao;
    ALTER TABLE consulta DROP COLUMN IF EXISTS periodo;
  `);
};
