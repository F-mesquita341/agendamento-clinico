'use strict';

/**
 * Tradução de objetos do domínio para o JSON da API.
 *
 * Existe para que a forma da resposta HTTP não vaze para dentro do domínio.
 * O domínio fala em `Dinheiro` e `Date`; o cliente recebe centavos, texto
 * formatado e ISO 8601.
 *
 * Nomes dos campos em camelCase, ainda que as colunas do banco usem
 * snake_case: a fronteira de tradução é exatamente aqui.
 */

function especialidade(e) {
  return { id: e.id, nome: e.nome };
}

function profissional(p) {
  return {
    id: p.id,
    nome: p.nome,
    registroConselho: p.registroConselho,
    especialidade: p.especialidade ? especialidade(p.especialidade) : null,
    valorCentavos: p.valorConsulta.centavos,
    valorFormatado: p.valorConsulta.formatar(),
  };
}

/**
 * O campo `versao` é obrigatório aqui.
 *
 * É ele que o aplicativo devolve no POST /consultas, e é contra ele que a
 * cláusula WHERE do lock otimista compara. Sem `versao` na resposta, não há
 * como detectar que outra pessoa reservou o horário no intervalo — omiti-lo
 * quebraria o controle de concorrência sem gerar nenhum erro visível.
 */
function horario(h) {
  return {
    id: h.id,
    inicio: h.inicio.toISOString(),
    fim: h.fim.toISOString(),
    duracaoMinutos: h.duracaoEmMinutos(),
    versao: h.versao,
  };
}

module.exports = { especialidade, profissional, horario };
