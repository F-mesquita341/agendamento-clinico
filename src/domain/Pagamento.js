'use strict';

/**
 * Pagamento de consulta — o que fazer quando o provedor reporta um pagamento.
 *
 * O adaptador de persistência lê a consulta sob bloqueio e pergunta a esta
 * função o que fazer; ela não lê nem grava nada. É aqui que ficam as regras
 * que tocam o dinheiro do paciente, e por isso elas são testadas sem banco.
 *
 * O pagamento chega já traduzido pelo adaptador do provedor: nenhum nome do
 * Mercado Pago aparece neste arquivo.
 */

const { STATUS_CONSULTA } = require('./Consulta');

const STATUS = Object.freeze({
  PENDENTE: 'pendente',
  APROVADO: 'aprovado',
  RECUSADO: 'recusado',
  ESTORNADO: 'estornado',
  EXPIRADO: 'expirado',
});

/**
 * O que o provedor de pagamento fica sabendo sobre o que foi comprado.
 *
 * Genérico de propósito (LGPD, Art. 11 §4º): nem especialidade, nem nome do
 * profissional. O extrato do cartão e o painel do provedor não precisam
 * revelar que tipo de consulta a pessoa marcou.
 */
const DESCRICAO_DO_ITEM = 'Consulta médica';

/**
 * @param {object} p
 * @param {import('./Consulta').Consulta} p.consulta estado atual, lido sob bloqueio
 * @param {{status: string, valorCentavos: number, moeda: string, modoReal: boolean}} p.pagamento
 *        como o provedor o reportou, na busca feita pela própria API
 * @param {string|null} p.statusAnterior status já gravado para ESTE pagamento
 *        do provedor, ou null se é a primeira notícia dele
 * @returns {{acao: 'registrar'|'ignorar', statusDoPagamento: string|null,
 *            confirmarConsulta: boolean, anomalia: string|null}}
 */
function decidirEfeitoDoPagamento({ consulta, pagamento, statusAnterior }) {
  // Trava de segurança acadêmica: o trabalho opera só em sandbox. Um pagamento
  // real não é gravado como se fosse de teste — é ignorado e denunciado.
  if (pagamento.modoReal) {
    return { acao: 'ignorar', statusDoPagamento: null, confirmarConsulta: false, anomalia: 'pagamento_em_modo_real' };
  }

  // O provedor já nos contou isto. Reenvio de notificação é rotina: não muda
  // nada e não gera auditoria nova.
  if (statusAnterior === pagamento.status) {
    return { acao: 'ignorar', statusDoPagamento: pagamento.status, confirmarConsulta: false, anomalia: null };
  }

  const registrar = (confirmarConsulta, anomalia) => ({
    acao: 'registrar',
    statusDoPagamento: pagamento.status,
    confirmarConsulta,
    anomalia,
  });

  // O valor é o congelado na consulta no momento do agendamento. Qualquer
  // diferença — valor ou moeda — impede a confirmação: ou é defeito, ou é
  // alguém pagando menos pelo mesmo checkout.
  const valorConfere =
    pagamento.moeda === 'BRL' && pagamento.valorCentavos === consulta.valor.centavos;
  if (!valorConfere) {
    return registrar(false, 'valor_divergente');
  }

  if (pagamento.status !== STATUS.APROVADO) {
    // Um pagamento que ESTAVA aprovado e deixou de estar — estorno, ou
    // contestação, que o provedor reporta como pendente. A consulta continua
    // confirmada, ocupando o horário, mas sem pagamento válido por trás: é
    // caso para alguém olhar, não para mudança automática de estado.
    const revertido = statusAnterior === STATUS.APROVADO;
    return registrar(false, revertido ? 'pagamento_revertido' : null);
  }

  if (consulta.status === STATUS_CONSULTA.PENDENTE_PAGAMENTO) {
    return registrar(true, null);
  }
  if (consulta.status === STATUS_CONSULTA.CONFIRMADA) {
    // Confirmada por OUTRO pagamento — este é um segundo, para estorno.
    return registrar(false, 'pagamento_duplicado');
  }
  // Cancelada — pelo paciente ou por expiração. O horário pode já ser de outra
  // pessoa, então a consulta não volta: o pagamento fica registrado para
  // estorno.
  return registrar(false, 'pagamento_apos_cancelamento');
}

module.exports = { decidirEfeitoDoPagamento, STATUS_PAGAMENTO: STATUS, DESCRICAO_DO_ITEM };
