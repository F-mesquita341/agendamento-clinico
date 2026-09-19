'use strict';

/**
 * POST /webhooks/mercadopago — o aviso de que um pagamento mudou.
 *
 * Rota PÚBLICA: o Mercado Pago precisa alcançá-la sem token. O que a protege é
 * a assinatura (ver infra/pagamento/assinaturaMercadoPago.js), verificada antes
 * de qualquer outra coisa. Sem assinatura válida, 401 e nada muda.
 *
 * Mesmo assinada, a notificação só diz "o pagamento X mudou": o estado é
 * buscado no próprio Mercado Pago pelo caso de uso.
 *
 * Respostas: 200 quando processada ou ignorada (outros tipos de evento); 401
 * sem assinatura válida; 503 se o Mercado Pago não responder à consulta do
 * pagamento — o que faz o próprio Mercado Pago reenviar mais tarde, que é
 * exatamente o que se quer.
 */

const { Router } = require('express');

const { ProcessarNotificacaoDePagamento } = require('../../../application/ProcessarNotificacaoDePagamento');
const { RepositorioDePagamentosPg } = require('../../../infra/db/RepositorioDePagamentosPg');
const { verificarAssinatura } = require('../../../infra/pagamento/assinaturaMercadoPago');

function criarRotasDeWebhook({ gateway, segredo, pagamentos = new RepositorioDePagamentosPg() }) {
  const rotas = Router();
  const processar = new ProcessarNotificacaoDePagamento({ gateway, pagamentos });

  rotas.post('/mercadopago', async (req, res, next) => {
    try {
      // Chave com ponto na query string: o analisador do Express não a
      // desmonta, e ela chega como `data.id`. Repetida, chegaria como lista —
      // e então não serve.
      const idDoDado = typeof req.query['data.id'] === 'string' ? req.query['data.id'] : undefined;

      const verificacao = verificarAssinatura({
        cabecalhoAssinatura: req.get('x-signature'),
        idDaRequisicao: req.get('x-request-id'),
        idDoDado,
        segredo,
      });

      if (!verificacao.valida) {
        // O motivo vai para o log, não para a resposta: quem está forjando não
        // precisa saber o que corrigir.
        console.warn(`Webhook do Mercado Pago recusado: ${verificacao.motivo}`);
        return res.status(401).json({
          erro: { codigo: 'ASSINATURA_INVALIDA', mensagem: 'Notificação sem assinatura válida.', acao: null },
        });
      }

      const tipo = req.query.type ?? req.body?.type;
      if (tipo !== 'payment') {
        return res.status(200).json({ recebido: true });
      }

      await processar.executar({ pagamentoId: idDoDado });
      return res.status(200).json({ recebido: true });
    } catch (erro) {
      return next(erro);
    }
  });

  return rotas;
}

module.exports = { criarRotasDeWebhook };
