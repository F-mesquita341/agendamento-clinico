'use strict';

/**
 * Prepara o banco de TESTE com um cenário conhecido.
 *
 * Diferente do seed de desenvolvimento, aqui os dados são mínimos e
 * determinísticos: cada teste precisa saber exatamente o que existe para poder
 * afirmar o que espera.
 *
 * Limpa tudo antes de inserir. O guarda em config.js garante que isto nunca
 * rode contra o banco de desenvolvimento.
 */

const { consultar } = require('../../src/infra/db/pool');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../../src/domain/Paciente');

/** Ordem inversa às dependências de chave estrangeira. */
async function limpar() {
  await consultar(`
    TRUNCATE auditoria, pagamento, device_token, consulta, horario,
             profissional, especialidade, paciente, clinica
    RESTART IDENTITY CASCADE;
  `);
}

async function semear() {
  await limpar();

  const { rows: clinicas } = await consultar(
    `INSERT INTO clinica (nome, cnpj) VALUES ('Clínica de Teste', '11.111.111/0001-11')
     RETURNING id`
  );
  const clinicaId = clinicas[0].id;

  const { rows: esp } = await consultar(
    `INSERT INTO especialidade (nome)
     VALUES ('Cardiologia'), ('Pediatria')
     RETURNING id, nome`
  );
  const cardiologia = esp.find((e) => e.nome === 'Cardiologia');
  const pediatria = esp.find((e) => e.nome === 'Pediatria');

  const { rows: profs } = await consultar(
    `INSERT INTO profissional
       (clinica_id, especialidade_id, nome, registro_conselho,
        valor_consulta_centavos, ativo)
     VALUES
       ($1, $2, 'José Antônio Ferreira', 'CRM-CE 11111', 25000, TRUE),
       ($1, $3, 'Inês Cardoso Lima',     'CRM-CE 22222', 18000, TRUE),
       ($1, $2, 'Marcos Aposentado',     'CRM-CE 33333', 20000, FALSE)
     RETURNING id, nome`,
    [clinicaId, cardiologia.id, pediatria.id]
  );

  const jose = profs.find((p) => p.nome.startsWith('José'));
  const ines = profs.find((p) => p.nome.startsWith('Inês'));
  const inativo = profs.find((p) => p.nome.startsWith('Marcos'));

  // Três horários para o José: um no passado, dois no futuro; e um já
  // reservado, que não pode aparecer na listagem de disponíveis.
  const { rows: horarios } = await consultar(
    `INSERT INTO horario (profissional_id, inicio, fim, status, versao)
     VALUES
       ($1, now() - interval '2 hours', now() - interval '90 minutes', 'disponivel', 0),
       ($1, now() + interval '1 day',   now() + interval '1 day 30 minutes', 'disponivel', 0),
       ($1, now() + interval '2 days',  now() + interval '2 days 30 minutes', 'disponivel', 7),
       ($1, now() + interval '3 days',  now() + interval '3 days 30 minutes', 'reservado', 1)
     RETURNING id, inicio, status, versao`,
    [jose.id]
  );

  // Um horário da Inês no MESMO instante do "amanhã" do José — é com ele que se
  // testa a sobreposição na agenda do paciente —, e um do profissional
  // desativado, que não pode ser agendado por ninguém.
  const { rows: outros } = await consultar(
    `INSERT INTO horario (profissional_id, inicio, fim, status, versao)
     VALUES
       ($1, $3::timestamptz, $3::timestamptz + interval '30 minutes', 'disponivel', 0),
       ($2, now() + interval '1 day', now() + interval '1 day 30 minutes', 'disponivel', 0)
     RETURNING id`,
    [ines.id, inativo.id, horarios[1].inicio]
  );

  return {
    clinicaId: Number(clinicaId),
    especialidades: {
      cardiologia: Number(cardiologia.id),
      pediatria: Number(pediatria.id),
    },
    profissionais: {
      jose: Number(jose.id),
      ines: Number(ines.id),
      inativo: Number(inativo.id),
    },
    horarios: {
      passado: Number(horarios[0].id),
      amanha: Number(horarios[1].id),
      comVersao7: Number(horarios[2].id),
      reservado: Number(horarios[3].id),
      // Mesmo instante do `amanha`, com outro profissional.
      amanhaComInes: Number(outros[0].id),
      deProfissionalInativo: Number(outros[1].id),
    },
  };
}

/**
 * Dois pacientes já cadastrados, com os uids que `tokenDe` produz nos testes.
 *
 * Inseridos direto no banco, e não por `POST /pacientes`: o cadastro tem
 * arquivo de teste próprio, e gastar duas requisições HTTP em cada caso de
 * agendamento só tornaria a suíte mais lenta sem provar nada de novo.
 */
async function semearPacientes() {
  const { rows } = await consultar(
    `INSERT INTO paciente
       (firebase_uid, nome, email, consentimento_versao, consentimento_em)
     VALUES
       ('uid-paciente-a', 'Ana Paciente',   'paciente.a@example.com', $1, now()),
       ('uid-paciente-b', 'Bruno Paciente', 'paciente.b@example.com', $1, now())
     RETURNING id, firebase_uid`,
    [VERSAO_TERMO_CONSENTIMENTO]
  );

  const porUid = (uid) => Number(rows.find((r) => r.firebase_uid === uid).id);
  return { a: porUid('uid-paciente-a'), b: porUid('uid-paciente-b') };
}

module.exports = { semear, semearPacientes, limpar };
