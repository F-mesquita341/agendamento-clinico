'use strict';

/**
 * Consultas de exemplo da versão 2 — SÓ PARA A HOMOLOGAÇÃO. Pacientes
 * fictícios com um histórico de consultas em Quixadá e Quixeramobim, para a
 * agenda dos profissionais de demonstração não parecer vazia.
 *
 *   npm run seed -- --ate AAAA-MM-DD                 # 1º: o seed base
 *   npm run seed:demonstracao -- --ate AAAA-MM-DD    # 2º: o catálogo
 *   npm run seed:exemplos                            # 3º: este
 *
 * O que cria, sempre o mesmo (sem sorteio):
 *   - 10 pacientes fictícios. O identificador de conta começa com
 *     `demonstracao-paciente-` e não existe no Firebase: ninguém entra no
 *     aplicativo com eles. O e-mail é do domínio reservado `exemplo.invalid`.
 *     O banco exige consentimento registrado (Art. 11 da LGPD), então eles
 *     levam a versão vigente do termo — é dado fictício, não um aceite.
 *   - 40 consultas nos 20 dias úteis anteriores a hoje: realizadas, faltas
 *     (`nao_compareceu`) e canceladas pelo paciente, nas três formas de
 *     pagamento. Os horários passados são criados só onde há consulta.
 *   - 15 consultas confirmadas nos 10 dias úteis seguintes, em horários da
 *     grade que estejam livres (os que outra pessoa já reservou são pulados).
 *   - Pagamento `aprovado`, em sandbox e com referência fictícia, para as
 *     consultas pelo aplicativo que não foram canceladas.
 *
 * O que NÃO cria, de propósito:
 *   - consulta `pendente_pagamento`: a rotina de expiração perguntaria ao
 *     Mercado Pago por um checkout que não existe;
 *   - nada da Íris (o caso "sem horário livre") nem de Fortaleza;
 *   - registro na auditoria: estas consultas não passaram pela API, e a
 *     auditoria registra o que a API fez.
 *
 * Os números que saem daqui são inventados e NÃO são resultado de nada. Não
 * entram na monografia como dado; no máximo como tela de demonstração, dita
 * fictícia.
 *
 * Rodar de novo não duplica: se os pacientes fictícios já têm consulta, nada
 * é criado. As consultas de outras pessoas (as contas de teste do aplicativo)
 * não são lidas nem tocadas.
 *
 * TRAVA: a mesma do catálogo — recusa, antes de qualquer escrita, banco com
 * "producao" ou "coleta" no nome.
 */

const config = require('../src/config');
const { consultar, transacao, encerrar } = require('../src/infra/db/pool');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../src/domain/Paciente');
const { descreverBanco } = require('./descreverBanco');
const { hojeNaClinica, somarDias } = require('./periodoDoSeed');
const { bancoProibido, SEM_HORARIO_LIVRE } = require('./seed-demonstracao');

class Recusa extends Error {}

const PREFIXO_DO_UID = 'demonstracao-paciente-';

const PACIENTES = [
  // nome, data de nascimento
  ['Antônia Silva Mendes', '1958-03-14'],
  ['Benedito Alves Rocha', '1971-07-02'],
  ['Cícera Gomes Lima', '1989-11-23'],
  ['Damião Sousa Pereira', '1964-01-30'],
  ['Elisângela Costa Freitas', '1995-05-09'],
  ['Francisco Holanda Neto', '1980-09-17'],
  ['Gorete Bezerra Sales', '1976-12-05'],
  ['Hélio Martins Campos', '2001-04-21'],
  ['Iracema Lopes Vieira', '1952-08-11'],
  ['João Batista Moura', '1999-02-27'],
];

const CIDADES = ['Quixadá', 'Quixeramobim'];

const PASSADAS = 40;
const DIAS_PASSADOS = 20; // dias úteis antes de hoje
const FUTURAS = 15;
const DIAS_FUTUROS = 10; // dias úteis depois de hoje

// Os 14 começos de consulta da grade (gradeDoSeed.js): 7 de manhã, 7 à tarde.
const HORAS = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00',
];

/** Os `n` dias úteis antes (passo -1) ou depois (passo +1) de `hoje`. */
function diasUteis(hoje, passo, n) {
  const dias = [];
  for (let d = somarDias(hoje, passo); dias.length < n; d = somarDias(d, passo)) {
    const semana = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (semana >= 1 && semana <= 5) dias.push(d);
  }
  return passo < 0 ? dias.reverse() : dias;
}

/**
 * Onde cai a consulta número `i` de `total`, espalhadas em `dias`.
 *
 * O dia é `i % dias` e a metade do dia (manhã ou tarde) é `i / dias`; os dois
 * juntos identificam `i`. Por isso duas consultas nunca dividem dia e hora —
 * nem do mesmo profissional, nem do mesmo paciente —, e a restrição de
 * sobreposição do banco nunca é posta à prova por este seed.
 */
function posicao(i, dias) {
  const metade = Math.floor(i / dias);
  if (metade > 1) throw new Error(`Consultas demais para ${dias} dias: ${i}.`);
  return { dia: i % dias, hora: HORAS[metade * 7 + (i % 7)] };
}

/** A forma de pagamento da consulta `i`: alterna a preferência e cai na que o profissional aceita. */
function formaPara(i, profissional) {
  const ordens = [
    ['app', 'plano', 'clinica'],
    ['plano', 'clinica', 'app'],
    ['clinica', 'app', 'plano'],
  ];
  const aceita = {
    app: profissional.aceitaApp,
    plano: profissional.planoId !== null,
    clinica: profissional.aceitaClinica,
  };
  return ordens[i % 3].find((forma) => aceita[forma]);
}

/** O status da consulta passada `i`: 4 faltas e 4 cancelamentos em 40, espalhados entre os pacientes. */
function statusPassado(i) {
  // O deslocamento de 3 a cada dezena faz as faltas e os cancelamentos caírem
  // em pacientes e em posições da alternância de formas diferentes.
  const v = (i + 3 * Math.floor(i / 10)) % 10;
  if (v === 3) return 'nao_compareceu';
  if (v === 7) return 'cancelada';
  return 'realizada';
}

async function profissionaisDasCidades(cliente) {
  const { rows } = await cliente.query(
    `SELECT p.id, p.registro_conselho, p.valor_consulta_centavos AS valor,
            p.aceita_pagamento_no_app AS "aceitaApp",
            p.aceita_pagar_na_clinica AS "aceitaClinica",
            (SELECT pp.plano_id
               FROM profissional_plano pp
               JOIN plano_de_saude pds ON pds.id = pp.plano_id
              WHERE pp.profissional_id = p.id
              ORDER BY pds.nome LIMIT 1) AS "planoId"
       FROM profissional p
       JOIN clinica c ON c.id = p.clinica_id
       JOIN cidade ci ON ci.id = c.cidade_id
      WHERE p.ativo AND ci.nome = ANY($1) AND p.registro_conselho <> $2
      ORDER BY p.registro_conselho`,
    [CIDADES, SEM_HORARIO_LIVRE]
  );
  return rows.map((r) => ({ ...r, planoId: r.planoId === null ? null : Number(r.planoId) }));
}

async function criarConsulta(cliente, { pacienteId, horarioId, profissional, forma, status, passada }) {
  const { rows } = await cliente.query(
    `INSERT INTO consulta
       (paciente_id, horario_id, status, valor_centavos, periodo,
        forma_de_pagamento, plano_id, motivo_cancelamento, criado_em)
     SELECT $1, h.id, $3::status_consulta, $4, tstzrange(h.inicio, h.fim, '[)'),
            $5, $6, $7, CASE WHEN $8 THEN h.inicio - INTERVAL '3 days' ELSE now() END
       FROM horario h WHERE h.id = $2
     RETURNING id`,
    [
      pacienteId,
      horarioId,
      status,
      profissional.valor,
      forma,
      forma === 'plano' ? profissional.planoId : null,
      status === 'cancelada' ? 'paciente' : null,
      passada,
    ]
  );
  const consultaId = Number(rows[0].id);

  if (forma === 'app' && status !== 'cancelada') {
    await cliente.query(
      `INSERT INTO pagamento
         (consulta_id, referencia_externa, pagamento_externo_id, status, valor_centavos)
       VALUES ($1, $2, $3, 'aprovado', $4)`,
      [consultaId, `demonstracao-consulta-${consultaId}`, `demonstracao-${consultaId}`, profissional.valor]
    );
  }
}

async function semearExemplos(agora = new Date()) {
  const hoje = hojeNaClinica(agora);

  return transacao(async (cliente) => {
    const profissionais = await profissionaisDasCidades(cliente);
    if (profissionais.length === 0) {
      throw new Recusa(
        'Nenhum profissional de demonstração em Quixadá ou Quixeramobim. ' +
          'Rode antes `npm run seed` e `npm run seed:demonstracao`.'
      );
    }

    for (const [indice, [nome, nascimento]] of PACIENTES.entries()) {
      const numero = String(indice + 1).padStart(2, '0');
      await cliente.query(
        `INSERT INTO paciente
           (firebase_uid, nome, email, data_nascimento, consentimento_versao, consentimento_em)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (firebase_uid) DO NOTHING`,
        [`${PREFIXO_DO_UID}${numero}`, nome, `paciente${numero}@exemplo.invalid`, nascimento,
          VERSAO_TERMO_CONSENTIMENTO]
      );
    }
    const { rows: pacientes } = await cliente.query(
      `SELECT id FROM paciente WHERE firebase_uid LIKE $1 ORDER BY firebase_uid`,
      [`${PREFIXO_DO_UID}%`]
    );
    const pacienteIds = pacientes.map((p) => Number(p.id));

    const { rows: ja } = await cliente.query(
      `SELECT count(*)::int AS n FROM consulta WHERE paciente_id = ANY($1)`,
      [pacienteIds]
    );
    if (ja[0].n > 0) {
      return { jaExistiam: ja[0].n, passadas: 0, futuras: 0, puladas: 0 };
    }

    const passados = diasUteis(hoje, -1, DIAS_PASSADOS);
    let passadas = 0;
    for (let i = 0; i < PASSADAS; i += 1) {
      const { dia, hora } = posicao(i, DIAS_PASSADOS);
      const profissional = profissionais[i % profissionais.length];
      const status = statusPassado(i);
      // Horário passado: criado agora, ou o da grade antiga, se ainda estiver
      // livre e sem consulta ativa. O cancelado volta à grade, como o
      // cancelamento de verdade faria.
      const { rows } = await cliente.query(
        `INSERT INTO horario (profissional_id, inicio, fim, status, versao)
         SELECT $1, m, m + INTERVAL '30 minutes', $3::status_horario, 1
           FROM (SELECT ($2::timestamp AT TIME ZONE 'America/Fortaleza') AS m) t
         ON CONFLICT (profissional_id, inicio) DO UPDATE
            SET status = EXCLUDED.status, versao = horario.versao + 1
          WHERE horario.status = 'disponivel'
            AND NOT EXISTS (SELECT 1 FROM consulta c
                             WHERE c.horario_id = horario.id AND c.status <> 'cancelada')
         RETURNING id`,
        [profissional.id, `${passados[dia]} ${hora}`, status === 'cancelada' ? 'disponivel' : 'reservado']
      );
      if (rows.length === 0) continue; // horário de outra pessoa: não é deste seed
      await criarConsulta(cliente, {
        pacienteId: pacienteIds[i % pacienteIds.length],
        horarioId: Number(rows[0].id),
        profissional,
        forma: formaPara(i, profissional),
        status,
        passada: true,
      });
      passadas += 1;
    }

    const futuros = diasUteis(hoje, +1, DIAS_FUTUROS);
    let futuras = 0;
    let puladas = 0;
    for (let i = 0; i < FUTURAS; i += 1) {
      const { dia, hora } = posicao(i, DIAS_FUTUROS);
      const profissional = profissionais[(i * 5) % profissionais.length];
      // Reserva como o agendamento faria: só horário livre, versão + 1.
      const { rows } = await cliente.query(
        `UPDATE horario SET status = 'reservado', versao = versao + 1
          WHERE profissional_id = $1 AND status = 'disponivel'
            AND inicio = ($2::timestamp AT TIME ZONE 'America/Fortaleza')
          RETURNING id`,
        [profissional.id, `${futuros[dia]} ${hora}`]
      );
      if (rows.length === 0) {
        puladas += 1; // fora da grade, ou já reservado por outra pessoa
        continue;
      }
      await criarConsulta(cliente, {
        pacienteId: pacienteIds[i % pacienteIds.length],
        horarioId: Number(rows[0].id),
        profissional,
        forma: formaPara(i, profissional),
        status: 'confirmada',
        passada: false,
      });
      futuras += 1;
    }

    return { jaExistiam: 0, passadas, futuras, puladas };
  });
}

async function resumo() {
  const { rows } = await consultar(
    `SELECT c.status::text AS status, c.forma_de_pagamento AS forma, count(*)::int AS n
       FROM consulta c JOIN paciente p ON p.id = c.paciente_id
      WHERE p.firebase_uid LIKE $1
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [`${PREFIXO_DO_UID}%`]
  );
  return rows;
}

async function principal() {
  if (bancoProibido(config.urlDoBanco)) {
    console.error(
      `\nRecusado: ${descreverBanco(config.urlDoBanco)} parece ser um banco de produção ` +
        '(o nome tem "producao" ou "coleta", ou não dá para ler). As consultas de ' +
        'exemplo são fictícias e só vão para a homologação.\nNada foi escrito.\n'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Consultas de exemplo em ${descreverBanco(config.urlDoBanco)}...`);
  try {
    const r = await semearExemplos();
    if (r.jaExistiam > 0) {
      console.log(`  Os pacientes fictícios já tinham ${r.jaExistiam} consultas; nada foi criado.`);
    } else {
      console.log(`  ${r.passadas} consultas passadas e ${r.futuras} futuras criadas` +
        (r.puladas ? `; ${r.puladas} futuras puladas (horário fora da grade ou já reservado)` : ''));
    }
    console.table(await resumo());
  } catch (erro) {
    if (erro instanceof Recusa) {
      console.error(`\n${erro.message}\nNada foi escrito.\n`);
    } else {
      console.error('Falha nas consultas de exemplo (nada foi gravado):', erro.message);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  principal().finally(encerrar);
}

module.exports = { semearExemplos, diasUteis, posicao, formaPara, statusPassado, PREFIXO_DO_UID };
