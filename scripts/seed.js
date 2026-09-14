'use strict';

/**
 * Popula o banco com dados de trabalho.
 *
 * Idempotente: pode rodar quantas vezes quiser sem duplicar nada.
 *
 * Os nomes abaixo são FICTÍCIOS e servem só para desenvolver. Antes das
 * sessões de teste com participantes, troque pelos dados reais da clínica
 * parceira — buscar por um profissional inventado não mede reconhecimento
 * nem familiaridade, que é justamente o que as sessões precisam observar.
 */

const { consultar, encerrar } = require('../src/infra/db/pool');

const ESPECIALIDADES = [
  'Clínica Geral',
  'Cardiologia',
  'Dermatologia',
  'Ginecologia',
  'Ortopedia',
  'Pediatria',
];

const PROFISSIONAIS = [
  ['Ana Beatriz Nogueira', 'CRM-CE 12345', 'Clínica Geral', 15000],
  ['Carlos Eduardo Timbó', 'CRM-CE 23456', 'Cardiologia', 25000],
  ['Daniela Rocha Vieira', 'CRM-CE 34567', 'Dermatologia', 22000],
  ['Eduardo Parente Lima', 'CRM-CE 45678', 'Ortopedia', 20000],
  ['Fernanda Alencar Sá', 'CRM-CE 56789', 'Pediatria', 18000],
];

async function semear() {
  console.log('Semeando...');

  await consultar(`
    INSERT INTO clinica (nome, cnpj, telefone, endereco)
    VALUES ('Clínica Exemplo Quixadá', '00.000.000/0001-00',
            '(88) 3000-0000', 'Centro, Quixadá - CE')
    ON CONFLICT (cnpj) DO NOTHING;
  `);

  for (const nome of ESPECIALIDADES) {
    await consultar(
      `INSERT INTO especialidade (nome) VALUES ($1)
       ON CONFLICT (nome) DO NOTHING;`,
      [nome]
    );
  }

  const { rows: jaTem } = await consultar('SELECT count(*)::int AS n FROM profissional');
  if (jaTem[0].n === 0) {
    for (const [nome, registro, especialidade, valor] of PROFISSIONAIS) {
      await consultar(
        `INSERT INTO profissional
           (clinica_id, especialidade_id, nome, registro_conselho,
            valor_consulta_centavos)
         VALUES (
           (SELECT id FROM clinica ORDER BY id LIMIT 1),
           (SELECT id FROM especialidade WHERE nome = $3),
           $1, $2, $4
         );`,
        [nome, registro, especialidade, valor]
      );
    }
    console.log(`  ${PROFISSIONAIS.length} profissionais inseridos`);
  } else {
    console.log(`  ${jaTem[0].n} profissionais já existiam`);
  }

  // Agenda dos próximos 14 dias: seg a sex, 08:00–11:30 e 14:00–17:30,
  // em blocos de 30 minutos, no fuso de Fortaleza.
  const { rowCount: horariosCriados } = await consultar(`
    INSERT INTO horario (profissional_id, inicio, fim)
    SELECT p.id,
           (s.momento AT TIME ZONE 'America/Fortaleza'),
           (s.momento AT TIME ZONE 'America/Fortaleza') + INTERVAL '30 minutes'
      FROM profissional p
      CROSS JOIN LATERAL (
        SELECT gs AS momento
          FROM generate_series(
                 (date_trunc('day', (now() AT TIME ZONE 'America/Fortaleza'))
                   + INTERVAL '1 day')::timestamp,
                 (date_trunc('day', (now() AT TIME ZONE 'America/Fortaleza'))
                   + INTERVAL '14 days')::timestamp,
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
  `);
  console.log(`  ${horariosCriados} horários criados`);

  const { rows: resumo } = await consultar(`
    SELECT
      (SELECT count(*) FROM especialidade) AS especialidades,
      (SELECT count(*) FROM profissional)  AS profissionais,
      (SELECT count(*) FROM horario WHERE status = 'disponivel') AS disponiveis;
  `);
  console.log('Pronto:', resumo[0]);
}

semear()
  .catch((erro) => {
    console.error('Falha ao semear:', erro.message);
    process.exitCode = 1;
  })
  .finally(encerrar);
