'use strict';

/**
 * Adaptador PostgreSQL para pagamentos.
 *
 * Toda escrita trava a CONSULTA primeiro e o pagamento depois — a mesma ordem
 * da expiração de reservas (RepositorioDeConsultasPg.expirarSeVencida). Com a
 * ordem invertida num dos caminhos, um webhook e a rotina de expiração
 * chegando juntos poderiam se travar mutuamente. Com a mesma ordem, um espera o
 * outro, e quem chega depois encontra o estado novo: ou a consulta já foi
 * confirmada e não expira, ou já expirou e o pagamento vira anomalia para
 * estorno.
 *
 * Nenhum dado do pagador é gravado: só identificadores, status e valor.
 */

const { RepositorioDePagamentos } = require('../../domain/pagamentos');
const { decidirEfeitoDoPagamento } = require('../../domain/Pagamento');
const { consultar, transacao } = require('./pool');
const { COLUNAS_DA_CONSULTA, paraConsulta } = require('./mapeamentoDeConsulta');

const COLUNAS = `
  id, consulta_id, referencia_externa, pagamento_externo_id, status,
  valor_centavos, preferencia_id, checkout_url
`;

function paraCheckout(linha) {
  return {
    id: Number(linha.id),
    consultaId: Number(linha.consulta_id),
    referencia: linha.referencia_externa,
    pagamentoExternoId: linha.pagamento_externo_id,
    status: linha.status,
    valorCentavos: linha.valor_centavos,
    preferenciaId: linha.preferencia_id,
    checkoutUrl: linha.checkout_url,
  };
}

async function auditar(cliente, { atorTipo, atorId = null, acao, entidade, entidadeId, detalhe }) {
  await cliente.query(
    `INSERT INTO auditoria (ator_tipo, ator_id, acao, entidade, entidade_id, detalhe)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [atorTipo, atorId, acao, entidade, entidadeId, detalhe]
  );
}

async function consultaSobBloqueio(cliente, consultaId) {
  const { rows } = await cliente.query(
    `SELECT ${COLUNAS_DA_CONSULTA} FROM consulta WHERE id = $1 FOR UPDATE`,
    [consultaId]
  );
  return rows.length ? paraConsulta(rows[0]) : null;
}

class RepositorioDePagamentosPg extends RepositorioDePagamentos {
  async checkoutAberto(consultaId) {
    const { rows } = await consultar(
      `SELECT ${COLUNAS} FROM pagamento
        WHERE consulta_id = $1 AND status = 'pendente' AND pagamento_externo_id IS NULL`,
      [consultaId]
    );
    return rows.length ? paraCheckout(rows[0]) : null;
  }

  /**
   * Grava o checkout, conferindo de novo, sob bloqueio, que a consulta ainda
   * pode ser paga: entre a verificação do caso de uso e este ponto, a rotina de
   * expiração pode ter cancelado a reserva. Sem esta segunda conferência, o
   * paciente receberia a URL de pagamento de uma consulta que já não existe.
   */
  async registrarCheckout({ consultaId, pacienteId, referencia, valorCentavos, preferenciaId, checkoutUrl, agora }) {
    try {
      return await transacao(async (cliente) => {
        const consulta = await consultaSobBloqueio(cliente, consultaId);
        consulta.garantirQuePodeSerPagaPor(pacienteId, agora);

        const { rows } = await cliente.query(
          `INSERT INTO pagamento
             (consulta_id, referencia_externa, status, valor_centavos, preferencia_id, checkout_url)
           VALUES ($1, $2, 'pendente', $3, $4, $5)
           RETURNING ${COLUNAS}`,
          [consultaId, referencia, valorCentavos, preferenciaId, checkoutUrl]
        );

        await auditar(cliente, {
          atorTipo: 'paciente',
          atorId: pacienteId,
          acao: 'pagamento.checkout_criado',
          entidade: 'pagamento',
          entidadeId: rows[0].id,
          detalhe: { consultaId },
        });

        return paraCheckout(rows[0]);
      });
    } catch (erro) {
      // Dois pedidos simultâneos: o outro gravou primeiro. Vale o dele — o
      // checkout criado por este fica órfão no provedor, e como a URL dele
      // nunca é devolvida a ninguém, não há como pagá-lo.
      if (erro.code === '23505' && erro.constraint === 'pagamento_um_checkout_aberto') {
        const existente = await this.checkoutAberto(consultaId);
        if (existente) return existente;
      }
      throw erro;
    }
  }

  async aplicarPagamento(pagamento, { ator = 'webhook' } = {}) {
    if (!pagamento.referencia) {
      return { desfecho: 'sem_referencia', anomalia: null };
    }

    // A consulta de uma referência nunca muda, então esta leitura pode ser
    // feita sem bloqueio — e precisa: é ela que diz QUAL consulta travar.
    const { rows: origem } = await consultar(
      'SELECT consulta_id FROM pagamento WHERE referencia_externa = $1 LIMIT 1',
      [pagamento.referencia]
    );
    if (origem.length === 0) {
      return { desfecho: 'referencia_desconhecida', anomalia: null };
    }
    const consultaId = Number(origem[0].consulta_id);

    return transacao(async (cliente) => {
      const consulta = await consultaSobBloqueio(cliente, consultaId);
      const { rows: linhas } = await cliente.query(
        `SELECT ${COLUNAS} FROM pagamento WHERE referencia_externa = $1 ORDER BY id FOR UPDATE`,
        [pagamento.referencia]
      );

      const existente = linhas.find((l) => l.pagamento_externo_id === pagamento.id);
      const aberto = linhas.find((l) => l.pagamento_externo_id === null && l.status === 'pendente');

      const efeito = decidirEfeitoDoPagamento({
        consulta,
        pagamento,
        statusAnterior: existente?.status ?? null,
      });

      if (efeito.anomalia) {
        // O provedor reenvia a mesma notificação até receber 200, e há
        // anomalias que nunca chegam a virar linha de pagamento — a de modo
        // real, por exemplo. Sem esta conferência, cada reenvio gravaria a
        // mesma anomalia de novo, e a auditoria cresceria com repetições do
        // mesmo fato.
        const { rowCount: jaRegistrada } = await cliente.query(
          `SELECT 1 FROM auditoria
            WHERE acao = 'pagamento.anomalia'
              AND entidade = 'consulta'
              AND entidade_id = $1
              AND detalhe->>'pagamentoExterno' = $2
              AND detalhe->>'anomalia' = $3
            LIMIT 1`,
          [consultaId, pagamento.id, efeito.anomalia]
        );
        if (!jaRegistrada) {
          await auditar(cliente, {
            atorTipo: ator,
            acao: 'pagamento.anomalia',
            entidade: 'consulta',
            entidadeId: consultaId,
            detalhe: { anomalia: efeito.anomalia, pagamentoExterno: pagamento.id, status: pagamento.status },
          });
        }
      }

      if (efeito.acao === 'ignorar') {
        return { desfecho: efeito.anomalia ? 'anomalia' : 'sem_mudanca', anomalia: efeito.anomalia };
      }

      let pagamentoId;
      if (existente) {
        await cliente.query(
          'UPDATE pagamento SET status = $2, atualizado_em = now() WHERE id = $1',
          [existente.id, efeito.statusDoPagamento]
        );
        pagamentoId = existente.id;
      } else if (aberto) {
        // A primeira notícia de um pagamento feito pelo checkout aberto.
        await cliente.query(
          `UPDATE pagamento
              SET pagamento_externo_id = $2, status = $3, atualizado_em = now()
            WHERE id = $1`,
          [aberto.id, pagamento.id, efeito.statusDoPagamento]
        );
        pagamentoId = aberto.id;
      } else {
        // Um pagamento a mais para a mesma referência — segunda tentativa,
        // pagamento depois do cancelamento. Vira uma linha própria, com o
        // valor que o provedor de fato cobrou.
        const { rows } = await cliente.query(
          `INSERT INTO pagamento
             (consulta_id, referencia_externa, pagamento_externo_id, status, valor_centavos)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [consultaId, pagamento.referencia, pagamento.id, efeito.statusDoPagamento, pagamento.valorCentavos]
        );
        pagamentoId = rows[0].id;
      }

      await auditar(cliente, {
        atorTipo: ator,
        acao: `pagamento.${efeito.statusDoPagamento}`,
        entidade: 'pagamento',
        entidadeId: pagamentoId,
        detalhe: { consultaId, pagamentoExterno: pagamento.id },
      });

      if (efeito.confirmarConsulta) {
        await cliente.query(
          "UPDATE consulta SET status = 'confirmada', atualizado_em = now() WHERE id = $1",
          [consultaId]
        );
        await auditar(cliente, {
          atorTipo: ator,
          acao: 'consulta.confirmada',
          entidade: 'consulta',
          entidadeId: consultaId,
          detalhe: { pagamentoExterno: pagamento.id },
        });
      }

      return {
        desfecho: efeito.confirmarConsulta ? 'consulta_confirmada' : 'registrado',
        anomalia: efeito.anomalia,
      };
    });
  }
}

module.exports = { RepositorioDePagamentosPg };
