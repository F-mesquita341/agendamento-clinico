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
        //
        // Junto vão os NOMES dos parâmetros da query. Sem eles, `dados_ausentes`
        // diz que faltou `data.id` e não diz o que veio no lugar — e é essa
        // diferença que distingue uma notificação noutro formato (o IPN antigo
        // usa `topic` e `id`) de uma requisição forjada. Nomes, nunca valores.
        console.warn(
          `Webhook do Mercado Pago recusado: ${verificacao.motivo}; ` +
            `parâmetros na query: ${Object.keys(req.query).join(', ') || '(nenhum)'}; ` +
            `assinatura ${req.get('x-signature') ? 'presente' : 'ausente'}`
        );
        return res.status(401).json({
          erro: { codigo: 'ASSINATURA_INVALIDA', mensagem: 'Notificação sem assinatura válida.', acao: null },
        });
      }

      // Só a query: o corpo NÃO entra no manifesto assinado, e decidir por ele
      // contrariaria a regra que esta rota existe para cumprir. Uma notificação
      // assinada de outro evento, reenviada com o corpo trocado, seria aceita
      // como pagamento.
      if (req.query.type !== 'payment') {
        // Descartar em silêncio seria indistinguível, de fora, de "processei e
        // não havia o que fazer": os dois respondem 200. Se o Mercado Pago
        // mandar o evento noutro formato — o IPN antigo usa `topic` e `id` —,
        // todo pagamento se perderia sem deixar rastro. Os NOMES dos
        // parâmetros são o diagnóstico: dizem o que de fato chegou.
        console.warn(
          `Webhook do Mercado Pago ignorado: type=${req.query.type ?? '(ausente)'}; ` +
            `parâmetros na query: ${Object.keys(req.query).join(', ') || '(nenhum)'}`
        );
        return res.status(200).json({ recebido: true });
      }

      const resultado = await processar.executar({ pagamentoId: idDoDado });
      // O desfecho já era decidido e devolvido; até aqui era descartado.
      console.log(
        `Webhook do Mercado Pago: pagamento ${idDoDado} → ${resultado.desfecho}` +
          (resultado.anomalia ? ` (anomalia: ${resultado.anomalia})` : '')
      );
      return res.status(200).json({ recebido: true });
    } catch (erro) {
      return next(erro);
    }
  });

  return rotas;
}

module.exports = { criarRotasDeWebhook };
