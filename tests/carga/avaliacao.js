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
 *
 * Qual defesa recusou: o UPDATE condicional (versão e status) ou o índice único
 * parcial? O retorno do adaptador é o mesmo nos dois casos, e o estado final do
 * banco também — o índice recusa o INSERT e o ROLLBACK desfaz a reserva. O que
 * os distingue é a sequência de ids de `consulta`: toda tentativa de INSERT
 * consome um número, mesmo quando é desfeita. Se só o vencedor chegou ao
 * INSERT, a sequência avança exatamente 1; se ela avançou mais, perdedores
 * passaram pelo UPDATE e quem os segurou foi o índice.
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

/**
 * A recusa foi do UPDATE, e não do índice? Ver o cabeçalho do arquivo.
 *
 * @param {number} tentadas inserções que consumiram a sequência na rodada
 * @param {number} esperadas 1 quando há um vencedor; 0 quando ninguém deveria vencer
 */
function falhasDaSequencia(tentadas, esperadas) {
  if (tentadas === esperadas) return [];
  return [
    `${tentadas} tentativas de INSERT, esperada(s) ${esperadas} — recusas decididas pelo ` +
      'índice único, e não pelo UPDATE condicional',
  ];
}

/** Falhas comuns às fases A e B, lidas do estado do banco depois da rodada. */
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
  falhas.push(...falhasDaSequencia(banco.insercoesTentadas, 1));

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
  falhas.push(...falhasDaSequencia(banco.insercoesTentadas, 1));

  return {
    aprovada: falhas.length === 0,
    conflitos: Math.max(0, banco.consultasAtivas - 1),
    falhas,
  };
}

/**
 * Fase C: leitura desatualizada sob carga.
 *
 * O horário foi reservado e cancelado — está disponível de novo, na versão 2 —
 * e cem pedidos chegam com a versão 0, lida antes disso. O status confere; só
 * a condição de versão pode recusá-los. É o único cenário em que o papel
 * próprio do lock otimista aparece isolado: nas fases A e B, versão e status
 * falham juntos para todo perdedor.
 *
 * Depois da rajada, um pedido com a versão atual precisa ser aceito — prova de
 * que a recusa era pela desatualização, e não por o horário estar fora da grade.
 *
 * @param {object} rodada
 * @param {number} rodada.n
 * @param {Array<{status: number, codigo: string|null}>} rodada.respostas
 * @param {{consultasAtivas, versao, status, insercoesTentadas}} rodada.banco
 *        estado logo após a rajada, antes do pedido atualizado
 * @param {{status: number, codigo: string|null}} rodada.respostaAtualizada
 */
function avaliarRodadaDesatualizada({ n, respostas, banco, respostaAtualizada }) {
  const falhas = [];

  if (respostas.length !== n) {
    falhas.push(`${respostas.length} respostas para ${n} requisições`);
  }

  const aceitas = respostas.filter((r) => r.status === 201).length;
  const recusas = respostas.filter(
    (r) => r.status === 409 && r.codigo === 'HORARIO_INDISPONIVEL'
  ).length;
  const outras = respostas.length - aceitas - recusas;

  if (aceitas > 0) {
    falhas.push(`${aceitas} pedido(s) com a versão antiga aceito(s) — a leitura desatualizada passou`);
  }
  if (recusas !== n) {
    falhas.push(`${recusas} recusas 409, esperadas ${n}`);
  }
  if (outras > 0) {
    falhas.push(`${outras} respostas inesperadas`);
  }
  if (banco.consultasAtivas !== 0) {
    falhas.push(`${banco.consultasAtivas} consulta(s) ativa(s) depois da rajada, esperada nenhuma`);
  }
  if (banco.versao !== 2) {
    falhas.push(`versão do horário ${banco.versao}, esperada 2 — a rajada não devia mexer nela`);
  }
  if (banco.status !== 'disponivel') {
    falhas.push(`status do horário "${banco.status}", esperado "disponivel"`);
  }
  falhas.push(...falhasDaSequencia(banco.insercoesTentadas, 0));
  if (respostaAtualizada?.status !== 201) {
    falhas.push(
      `o pedido com a versão atual recebeu ${respostaAtualizada?.status} — ` +
        'a recusa não era pela desatualização'
    );
  }

  return {
    aprovada: falhas.length === 0,
    conflitos: Math.max(0, banco.consultasAtivas - 1),
    falhas,
  };
}

module.exports = {
  percentil,
  resumir,
  avaliarRodadaHttp,
  avaliarRodadaAdaptador,
  avaliarRodadaDesatualizada,
};
