'use strict';

/**
 * O texto do lembrete de consulta.
 *
 * Está no domínio, e não no adaptador do provedor, pelo mesmo motivo que
 * `DESCRICAO_DO_ITEM` em ./Pagamento.js: o que pode aparecer na notificação é
 * regra do trabalho, não detalhe de entrega. Aqui ela é uma função pura, e por
 * isso vira teste.
 *
 * A REGRA: nem especialidade, nem nome do profissional, nem motivo da consulta.
 * Notificação aparece em tela bloqueada, e quem estiver por perto lê. "Consulta
 * com o cardiologista amanhã" é dado de saúde exposto a terceiro sem
 * consentimento dele — LGPD, Art. 11. O paciente abre o aplicativo para saber o
 * resto; o lembrete só precisa fazê-lo lembrar.
 *
 * O fuso é o de Fortaleza, que é o da clínica. Formatar em UTC mostraria a
 * consulta das 8h como 11h.
 */

const FUSO = 'America/Fortaleza';

const FORMATO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** As partes da data já no fuso da clínica, como números. */
function partesEm(data) {
  const partes = Object.fromEntries(
    FORMATO.formatToParts(data)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  return {
    dia: `${partes.year}-${partes.month}-${partes.day}`,
    diaEMes: `${partes.day}/${partes.month}`,
    // 24h à meia-noite aparece como "24" em alguns ambientes; normaliza.
    hora: `${partes.hour === '24' ? '00' : partes.hour}:${partes.minute}`,
  };
}

/** Quantos dias de calendário separam duas datas, no fuso da clínica. */
function diasDeDistancia(de, ate) {
  const dia = (d) => Date.parse(`${partesEm(d).dia}T00:00:00Z`);
  return Math.round((dia(ate) - dia(de)) / 86_400_000);
}

/**
 * @param {Date} inicio começo da consulta
 * @param {Date} agora
 * @returns {{titulo: string, corpo: string}}
 */
function textoDoLembrete(inicio, agora) {
  const { hora, diaEMes } = partesEm(inicio);
  const distancia = diasDeDistancia(agora, inicio);

  const quando =
    distancia === 0 ? `hoje às ${hora}` : distancia === 1 ? `amanhã às ${hora}` : `em ${diaEMes}, às ${hora}`;

  return {
    titulo: 'Lembrete de consulta',
    corpo: `Você tem uma consulta ${quando}.`,
  };
}

module.exports = { textoDoLembrete, FUSO_DA_CLINICA: FUSO };
