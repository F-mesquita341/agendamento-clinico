'use strict';

/**
 * Limite de escritas por paciente — Etapa 10.
 *
 * POR PACIENTE, NÃO POR IP. Celulares atrás do NAT de uma operadora
 * compartilham IP, e um limite por IP puniria desconhecidos uns pelos outros. A
 * chave é o `uid` do token já verificado — por isso este middleware vem sempre
 * DEPOIS de `autenticar`. Posto antes, `req.usuario` não existe e a requisição
 * estoura com erro interno: falha alta, e não um limite global silencioso.
 *
 * Uma instância por app, criada em `criarApp` e passada a todos os roteadores:
 * o orçamento é do paciente, somado entre todas as rotas de escrita. Uma
 * instância por roteador daria a cada rota um orçamento próprio, e o limite
 * valeria sete vezes o que diz.
 *
 * Só escritas. O webhook fica de fora: o Mercado Pago reenvia o que recebe 429,
 * e a assinatura já barra o que não vem dele. Leituras também: não mudam nada.
 *
 * Pedido recusado — 400, 404, 422 — também conta, que é o padrão da
 * biblioteca. Se só os bem-sucedidos contassem, bastaria mandar lixo para
 * escrever à vontade.
 *
 * Em memória. No Render há uma instância só; com várias, cada uma contaria à
 * parte — limitação registrada no README.
 */

const { rateLimit } = require('express-rate-limit');

const JANELA_MS = 60_000;

/**
 * @param {object} opcoes
 * @param {number} opcoes.limitePorMinuto escritas permitidas por paciente, por minuto
 */
function criarLimiteDeEscritas({ limitePorMinuto }) {
  return rateLimit({
    windowMs: JANELA_MS,
    limit: limitePorMinuto,
    keyGenerator: (req) => req.usuario.uid,
    // Cabeçalhos padrão (RateLimit e RateLimit-Policy) e o Retry-After, que a
    // biblioteca põe sozinha quando o limite estoura: o aplicativo sabe
    // quanto esperar sem adivinhar.
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        erro: {
          codigo: 'MUITAS_REQUISICOES',
          mensagem: 'Muitas operações em pouco tempo. Aguarde um instante e tente de novo.',
          acao: 'tentar_novamente',
        },
      });
    },
  });
}

module.exports = { criarLimiteDeEscritas };
