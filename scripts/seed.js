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
 * Os dados da clínica se trocam com `npm run clinica:atualizar`.
 *
 * Período da agenda: os próximos 14 dias, ou o que vier em `--ate AAAA-MM-DD`
 * ou `--dias N` (ver periodoDoSeed.js):
 *
 *   npm run seed -- --ate 2026-12-15
 */

const config = require('../src/config');
const { consultar, encerrar } = require('../src/infra/db/pool');
const { descreverBanco } = require('./descreverBanco');
const { lerPeriodo, PeriodoInvalido } = require('./periodoDoSeed');
const { criarGrade } = require('./gradeDoSeed');

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

async function semear({ hoje, ultimoDia }) {
  console.log(`Semeando ${descreverBanco(config.urlDoBanco)}, horários até ${ultimoDia}...`);

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

  const horariosCriados = await criarGrade(consultar, { hoje, ultimoDia });
  console.log(`  ${horariosCriados} horários criados`);

  const { rows: resumo } = await consultar(`
    SELECT
      (SELECT count(*) FROM especialidade) AS especialidades,
      (SELECT count(*) FROM profissional)  AS profissionais,
      (SELECT count(*) FROM horario WHERE status = 'disponivel') AS disponiveis;
  `);
  console.log('Pronto:', resumo[0]);
}

async function principal() {
  let periodo;
  try {
    // Antes de qualquer escrita: argumento errado não deixa meia agenda.
    periodo = lerPeriodo(process.argv.slice(2));
  } catch (erro) {
    if (!(erro instanceof PeriodoInvalido)) throw erro;
    console.error(`\n${erro.message}\nNada foi escrito.\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await semear(periodo);
  } catch (erro) {
    console.error('Falha ao semear:', erro.message);
    process.exitCode = 1;
  }
}

principal().finally(encerrar);
