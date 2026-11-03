'use strict';

/**
 * Até quando o seed cria horários.
 *
 * Sem argumento, os próximos 14 dias, como sempre. Com `--ate AAAA-MM-DD`, até
 * aquele dia, inclusive; com `--dias N`, os N dias seguintes a hoje. Serve para
 * uma rodada só cobrir a coleta inteira, em vez de rodar o seed em produção
 * antes de cada dia de sessão.
 *
 * Função pura e separada do seed porque a recusa precisa vir antes de qualquer
 * escrita: um argumento errado não pode deixar meia agenda no banco.
 */

const { FUSO_DA_CLINICA } = require('../src/domain/Relogio');

const DIAS_PADRAO = 14;

// Teto de segurança: 120 dias são cerca de 1.200 horários por profissional.
// Uma data digitada com o ano errado não deveria encher a grade de anos.
const LIMITE_DE_DIAS = 120;

class PeriodoInvalido extends Error {}

/** 'AAAA-MM-DD' de hoje, no fuso da clínica — o mesmo dia que o SQL usa. */
function hojeNaClinica(agora) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_DA_CLINICA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
}

function somarDias(dataIso, dias) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function diasEntre(deIso, ateIso) {
  return Math.round((Date.parse(`${ateIso}T00:00:00Z`) - Date.parse(`${deIso}T00:00:00Z`)) / 86_400_000);
}

function valorDe(args, nome) {
  const i = args.indexOf(nome);
  if (i < 0) return undefined;
  const valor = args[i + 1];
  if (valor === undefined || valor.startsWith('--')) {
    throw new PeriodoInvalido(`${nome} precisa de um valor.`);
  }
  return valor;
}

/**
 * @param {string[]} args os argumentos da linha de comando
 * @param {Date} [agora]
 * @returns {{ hoje: string, ultimoDia: string }} datas 'AAAA-MM-DD' no fuso
 *          da clínica; os horários vão de amanhã até `ultimoDia`, inclusive
 */
function lerPeriodo(args, agora = new Date()) {
  const hoje = hojeNaClinica(agora);
  const ate = valorDe(args, '--ate');
  const dias = valorDe(args, '--dias');

  if (ate !== undefined && dias !== undefined) {
    throw new PeriodoInvalido('Use --ate ou --dias, não os dois.');
  }

  let ultimoDia;
  if (ate !== undefined) {
    // A volta pela data confere o dia: 2026-02-30 vira 2026-03-02 e é recusado.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ate) || somarDias(ate, 0) !== ate) {
      throw new PeriodoInvalido(`--ate precisa ser uma data AAAA-MM-DD válida; recebi "${ate}".`);
    }
    if (ate <= hoje) {
      throw new PeriodoInvalido(`--ate precisa ser depois de hoje (${hoje}).`);
    }
    ultimoDia = ate;
  } else if (dias !== undefined) {
    if (!/^\d+$/.test(dias) || Number(dias) < 1) {
      throw new PeriodoInvalido(`--dias precisa ser um número inteiro positivo; recebi "${dias}".`);
    }
    ultimoDia = somarDias(hoje, Number(dias));
  } else {
    ultimoDia = somarDias(hoje, DIAS_PADRAO);
  }

  if (diasEntre(hoje, ultimoDia) > LIMITE_DE_DIAS) {
    throw new PeriodoInvalido(
      `O período passa de ${LIMITE_DE_DIAS} dias (até ${ultimoDia}). Confira a data.`
    );
  }
  return { hoje, ultimoDia };
}

module.exports = { lerPeriodo, PeriodoInvalido, DIAS_PADRAO, LIMITE_DE_DIAS };
