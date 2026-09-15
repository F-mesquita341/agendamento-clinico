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
    },
  };
}

module.exports = { semear, limpar };
