'use strict';

/**
 * Avaliação do teste de carga — funções puras, sem banco e sem rede.
 *
 * Separadas do executor para poderem ser testadas com entradas sintéticas: o
 * sistema real não produz agendamento duplicado sem desmontar três defesas, e
 * um detector que nunca viu uma falha não prova que sabe reconhecê-la. Ver
 * tests/unit/avaliacaoDeCarga.test.js.
 *
 * Vocabulário, que vale também para o relatório e para a monografia:
 *
 *   CONFLITO — agendamento duplicado: mais de uma consulta ativa no mesmo
 *              horário. É o que a Seção 4.5 do projeto exige que seja zero.
 *   RECUSA   — resposta 409 a quem perdeu a disputa. É o resultado CORRETO, e
 *              99 por rodada é o esperado. O HTTP chama o 409 de "Conflict", e
 *              é justamente por isso que o texto precisa separar as palavras.
 */

/**
 * Percentil pelo método do posto mais próximo.
 *
 * Sem interpolação: o valor devolvido é sempre uma latência que de fato
 * aconteceu, o que é mais honesto num relatório com poucas amostras.
 */
function percentil(valores, p) {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const posicao = Math.ceil((p / 100) * ordenados.length) - 1;
  return ordenados[Math.min(Math.max(posicao, 0), ordenados.length - 1)];
}

function resumir(valores) {
  return {
    minimo: percentil(valores, 0),
    p50: percentil(valores, 50),
    p95: percentil(valores, 95),
    maximo: percentil(valores, 100),
  };
}

/** Falhas comuns às duas fases, lidas do estado do banco depois da rodada. */
function falhasDoBanco(banco) {
  const falhas = [];
  if (banco.consultasAtivas > 1) {
    falhas.push(
      `${banco.consultasAtivas} consultas ativas no mesmo horário — agendamento duplicado`
    );
  } else if (banco.consultasAtivas === 0) {
    falhas.push('nenhuma consulta ativa no horário — ninguém conseguiu agendar');
  }
  if (banco.versao !== 1) {
    falhas.push(`versão do horário ${banco.versao}, esperada 1 — uma única reserva, um único incremento`);
  }
  return falhas;
}

/**
 * Fase A: 100 requisições HTTP simultâneas pelo mesmo horário.
 *
 * @param {object} rodada
 * @param {number} rodada.n requisições disparadas
 * @param {Array<{status: number, codigo: string|null}>} rodada.respostas
 * @param {{consultasAtivas, versao, status, auditorias, valorCentavos}} rodada.banco
 * @param {number} rodada.precoEsperado centavos do profissional
 * @returns {{aprovada: boolean, conflitos: number, falhas: string[]}}
 */
function avaliarRodadaHttp({ n, respostas, banco, precoEsperado }) {
  const falhas = [];

  if (respostas.length !== n) {
    falhas.push(`${respostas.length} respostas para ${n} requisições`);
  }

  const criadas = respostas.filter((r) => r.status === 201).length;
  const recusas = respostas.filter(
    (r) => r.status === 409 && r.codigo === 'HORARIO_INDISPONIVEL'
  ).length;
  const outras = respostas.filter(
    (r) => r.status !== 201 && !(r.status === 409 && r.codigo === 'HORARIO_INDISPONIVEL')
  );

  if (criadas !== 1) {
    falhas.push(`${criadas} agendamentos aceitos, esperado 1`);
  }
  if (recusas !== n - 1) {
    falhas.push(`${recusas} recusas 409, esperadas ${n - 1}`);
  }
  if (outras.length > 0) {
    // Agrupa por status e código: "3× 500 ERRO_INTERNO, 1× 422 CONSULTA_SOBREPOSTA".
    const grupos = new Map();
    for (const r of outras) {
      const chave = `${r.status} ${r.codigo ?? ''}`.trim();
      grupos.set(chave, (grupos.get(chave) ?? 0) + 1);
    }
    const descricao = [...grupos].map(([chave, qtd]) => `${qtd}× ${chave}`).join(', ');
    falhas.push(`respostas inesperadas: ${descricao}`);
  }

  falhas.push(...falhasDoBanco(banco));

  if (banco.status !== 'reservado') {
    falhas.push(`status do horário "${banco.status}", esperado "reservado"`);
  }
  if (banco.auditorias !== 1) {
    falhas.push(`${banco.auditorias} registros de auditoria do agendamento, esperado 1`);
  }
  if (banco.consultasAtivas >= 1 && banco.valorCentavos !== precoEsperado) {
    falhas.push(`valor da consulta ${banco.valorCentavos}, esperado ${precoEsperado}`);
  }

  return {
    aprovada: falhas.length === 0,
    conflitos: Math.max(0, banco.consultasAtivas - 1),
    falhas,
  };
}

/**
 * Fase B: 100 chamadas simultâneas direto ao adaptador, sem a checagem prévia
 * do caso de uso. Toda recusa aqui é decidida pelo UPDATE com a versão.
 *
 * @param {object} rodada
 * @param {number} rodada.n
 * @param {Array<{tipo: 'consulta'|'nulo'|'erro', erro?: string}>} rodada.resultados
 * @param {{consultasAtivas, versao}} rodada.banco
 */
function avaliarRodadaAdaptador({ n, resultados, banco }) {
  const falhas = [];

  const consultas = resultados.filter((r) => r.tipo === 'consulta').length;
  const nulos = resultados.filter((r) => r.tipo === 'nulo').length;
  const erros = resultados.filter((r) => r.tipo === 'erro');

  if (consultas !== 1) {
    falhas.push(`${consultas} consultas criadas, esperada 1`);
  }
  if (nulos !== n - 1) {
    falhas.push(`${nulos} recusas pelo lock, esperadas ${n - 1}`);
  }
  if (erros.length > 0) {
    const mensagens = [...new Set(erros.map((e) => e.erro))].join('; ');
    falhas.push(`${erros.length} exceções: ${mensagens}`);
  }

  falhas.push(...falhasDoBanco(banco));

  return {
    aprovada: falhas.length === 0,
    conflitos: Math.max(0, banco.consultasAtivas - 1),
    falhas,
  };
}

module.exports = { percentil, resumir, avaliarRodadaHttp, avaliarRodadaAdaptador };
