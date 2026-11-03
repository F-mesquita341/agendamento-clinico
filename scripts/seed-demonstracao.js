'use strict';

/**
 * Catálogo de demonstração da versão 2 ("iFood mínimo") — SÓ PARA A
 * HOMOLOGAÇÃO. Tudo aqui é fictício: cidades reais com clínicas, profissionais
 * e planos inventados (os nomes dos planos também, para não sugerir convênio
 * com operadora de verdade).
 *
 *   npm run seed                      # primeiro o seed base
 *   npm run seed:demonstracao         # depois este, com o mesmo período
 *
 * Rode sempre DEPOIS do seed base. Os dois são idempotentes, mas o base cria
 * horários para todo profissional ativo — inclusive o que aqui fica de
 * propósito sem horário livre. Rodar este por último restaura esse caso.
 *
 * Os três casos que o aplicativo precisa ver no card:
 *   - sem plano nenhum ................ Ana Beatriz Nogueira
 *   - com três planos ou mais ......... Carlos Eduardo Timbó
 *   - sem horário livre ............... Íris Monteiro Lopes
 * e as formas de pagamento variadas: quem aceita pagar na clínica, e quem não
 * aceita pagar pelo aplicativo.
 *
 * TRAVA: recusa rodar, antes de qualquer escrita, quando o nome do banco tem
 * "producao" ou "coleta" — o banco da coleta não pode receber dado fictício.
 */

const config = require('../src/config');
const { consultar, encerrar } = require('../src/infra/db/pool');
const { descreverBanco } = require('./descreverBanco');
const { lerPeriodo, PeriodoInvalido } = require('./periodoDoSeed');
const { criarGrade } = require('./gradeDoSeed');

class Recusa extends Error {}

/**
 * O banco desta URL é de produção? Pelo nome: `agendamento_producao` (o da
 * produção até a troca) e `agendamento_coleta` (o da coleta). URL ilegível
 * também é recusada: sem saber o banco, não se escreve dado fictício.
 */
function bancoProibido(url) {
  let nome;
  try {
    nome = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return true;
  }
  return nome === '' || /producao|coleta/i.test(nome);
}

const CIDADES = [
  // nome, uf, latitude e longitude aproximadas do centro
  ['Quixadá', 'CE', -4.9708, -39.0153],
  ['Quixeramobim', 'CE', -5.1990, -39.2927],
  ['Fortaleza', 'CE', -3.7319, -38.5267],
];

const CLINICAS = [
  // cnpj fictício, nome, cidade, latitude, longitude, telefone, endereço
  ['00.000.000/0002-00', 'Clínica Demonstração Quixeramobim', 'Quixeramobim',
    -5.2011, -39.2950, '(88) 3000-0002', 'Centro, Quixeramobim - CE'],
  ['00.000.000/0003-00', 'Clínica Demonstração Fortaleza', 'Fortaleza',
    -3.7340, -38.5290, '(85) 3000-0003', 'Centro, Fortaleza - CE'],
];

const PLANOS = ['Bem Cuidar', 'Mais Saúde Nordeste', 'Plano Vida Sertão', 'Saúde Central'];

const PROFISSIONAIS_NOVOS = [
  // registro, nome, especialidade, cnpj da clínica, valor, aceita app, aceita clínica
  ['CRM-CE 67890', 'Gabriela Matos Pinheiro', 'Cardiologia', '00.000.000/0002-00', 22000, true, true],
  ['CRM-CE 78901', 'Heitor Sampaio Brito', 'Ortopedia', '00.000.000/0003-00', 24000, false, true],
  ['CRM-CE 89012', 'Íris Monteiro Lopes', 'Pediatria', '00.000.000/0003-00', 19000, true, false],
];

// Planos por profissional (pelo registro). Quem não aparece não aceita plano.
const PLANOS_POR_PROFISSIONAL = {
  'CRM-CE 23456': ['Plano Vida Sertão', 'Saúde Central', 'Bem Cuidar'], // Carlos: três
  'CRM-CE 34567': ['Saúde Central'], // Daniela
  'CRM-CE 67890': ['Plano Vida Sertão'], // Gabriela
  'CRM-CE 78901': ['Mais Saúde Nordeste', 'Bem Cuidar'], // Heitor: só plano ou clínica
  'CRM-CE 89012': ['Mais Saúde Nordeste'], // Íris
};

// A Fernanda (pediatria, Quixadá) passa a aceitar também pagar na clínica.
const ACEITAM_PAGAR_NA_CLINICA = ['CRM-CE 56789'];

const SEM_HORARIO_LIVRE = 'CRM-CE 89012'; // Íris

async function semearDemonstracao(periodo) {
  for (const [nome, uf] of CIDADES) {
    await consultar(
      `INSERT INTO cidade (nome, uf) VALUES ($1, $2) ON CONFLICT (nome, uf) DO NOTHING`,
      [nome, uf]
    );
  }
  const cidadeId = async (nome) =>
    (await consultar(`SELECT id FROM cidade WHERE nome = $1 AND uf = 'CE'`, [nome])).rows[0].id;

  // A clínica do seed base passa a ficar em Quixadá.
  const [, , latQ, lonQ] = CIDADES[0];
  await consultar(
    `UPDATE clinica SET cidade_id = $1, latitude = $2, longitude = $3
      WHERE cnpj = '00.000.000/0001-00'`,
    [await cidadeId('Quixadá'), latQ, lonQ]
  );

  for (const [cnpj, nome, cidade, lat, lon, telefone, endereco] of CLINICAS) {
    await consultar(
      `INSERT INTO clinica (nome, cnpj, telefone, endereco, cidade_id, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (cnpj) DO NOTHING`,
      [nome, cnpj, telefone, endereco, await cidadeId(cidade), lat, lon]
    );
  }

  for (const nome of PLANOS) {
    await consultar(
      `INSERT INTO plano_de_saude (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING`,
      [nome]
    );
  }

  for (const [registro, nome, especialidade, cnpj, valor, app, clinica] of PROFISSIONAIS_NOVOS) {
    await consultar(
      `INSERT INTO profissional
         (clinica_id, especialidade_id, nome, registro_conselho, valor_consulta_centavos,
          aceita_pagamento_no_app, aceita_pagar_na_clinica)
       SELECT (SELECT id FROM clinica WHERE cnpj = $4),
              (SELECT id FROM especialidade WHERE nome = $3),
              $2, $1, $5, $6, $7
        WHERE NOT EXISTS (SELECT 1 FROM profissional WHERE registro_conselho = $1)`,
      [registro, nome, especialidade, cnpj, valor, app, clinica]
    );
  }

  await consultar(
    `UPDATE profissional SET aceita_pagar_na_clinica = true WHERE registro_conselho = ANY($1)`,
    [ACEITAM_PAGAR_NA_CLINICA]
  );

  for (const [registro, planos] of Object.entries(PLANOS_POR_PROFISSIONAL)) {
    await consultar(
      `INSERT INTO profissional_plano (profissional_id, plano_id)
       SELECT p.id, pds.id
         FROM profissional p, plano_de_saude pds
        WHERE p.registro_conselho = $1 AND pds.nome = ANY($2)
       ON CONFLICT DO NOTHING`,
      [registro, planos]
    );
  }

  // A mesma grade do seed base, agora também para os profissionais novos.
  const horarios = await criarGrade(consultar, periodo);

  // O caso "sem horário livre": tira os livres futuros dela. Os que têm
  // consulta (reservados) ficam — nunca se apaga horário com consulta.
  const { rowCount: retirados } = await consultar(
    `DELETE FROM horario h
      USING profissional p
      WHERE h.profissional_id = p.id AND p.registro_conselho = $1
        AND h.status = 'disponivel' AND h.inicio > now()
        AND NOT EXISTS (SELECT 1 FROM consulta c WHERE c.horario_id = h.id)`,
    [SEM_HORARIO_LIVRE]
  );

  const { rows } = await consultar(`
    SELECT
      (SELECT count(*) FROM cidade)::int          AS cidades,
      (SELECT count(*) FROM clinica)::int         AS clinicas,
      (SELECT count(*) FROM plano_de_saude)::int  AS planos,
      (SELECT count(*) FROM profissional)::int    AS profissionais`);
  return { ...rows[0], horarios, retirados };
}

async function principal() {
  let periodo;
  try {
    // Antes de qualquer escrita: banco proibido ou argumento errado.
    if (bancoProibido(config.urlDoBanco)) {
      throw new Recusa(
        `Recusado: ${descreverBanco(config.urlDoBanco)} parece ser um banco de produção ` +
          '(o nome tem "producao" ou "coleta", ou não dá para ler). O catálogo de ' +
          'demonstração é fictício e só vai para a homologação.'
      );
    }
    periodo = lerPeriodo(process.argv.slice(2));
  } catch (erro) {
    if (!(erro instanceof Recusa || erro instanceof PeriodoInvalido)) throw erro;
    console.error(`\n${erro.message}\nNada foi escrito.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Catálogo de demonstração em ${descreverBanco(config.urlDoBanco)}, horários até ${periodo.ultimoDia}...`
  );
  try {
    const r = await semearDemonstracao(periodo);
    console.log(`  ${r.horarios} horários criados; ${r.retirados} retirados do caso "sem horário livre"`);
    console.log('Pronto:', {
      cidades: r.cidades,
      clinicas: r.clinicas,
      planos: r.planos,
      profissionais: r.profissionais,
    });
  } catch (erro) {
    console.error('Falha no catálogo de demonstração:', erro.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  principal().finally(encerrar);
}

module.exports = { bancoProibido, semearDemonstracao };
