'use strict';

/**
 * Verificação da assinatura das notificações (webhooks) do Mercado Pago.
 *
 * A rota do webhook é pública — o Mercado Pago precisa alcançá-la sem token.
 * O que impede um terceiro de forjar "o pagamento foi aprovado" é esta
 * assinatura: um HMAC SHA-256, com uma chave secreta que só o Mercado Pago e a
 * API conhecem, sobre um manifesto montado a partir da própria notificação:
 *
 *   id:<data.id da query, em minúsculas>;request-id:<x-request-id>;ts:<ts>;
 *
 * O cabeçalho `x-signature` traz `ts=<instante>,v1=<assinatura em hexadecimal>`.
 *
 * Mesmo com assinatura válida, a API não confia no conteúdo da notificação: ela
 * só diz "o pagamento X mudou", e o estado é buscado na API do Mercado Pago.
 * Por isso a reprodução de uma notificação legítima é inofensiva — e por isso
 * não há recusa por instante antigo: se o Mercado Pago reenviar com o instante
 * original, uma tolerância de tempo recusaria justamente os reenvios de que o
 * webhook depende quando a API está hibernando.
 *
 * O formato do manifesto é o documentado pelo Mercado Pago; a confirmação de
 * que ele bate com o real vem de uma notificação simulada pelo painel deles
 * contra a API publicada (Etapa 8, parte B).
 */

const crypto = require('node:crypto');

const HEX_DE_SHA256 = /^[0-9a-f]{64}$/i;

function lerCabecalho(cabecalho) {
  const partes = Object.fromEntries(
    cabecalho
      .split(',')
      .map((parte) => parte.trim())
      .filter(Boolean)
      .map((parte) => {
        const igual = parte.indexOf('=');
        return igual === -1 ? [parte, ''] : [parte.slice(0, igual).trim(), parte.slice(igual + 1).trim()];
      })
  );
  return { ts: partes.ts || null, v1: partes.v1 || null };
}

function montarManifesto({ idDoDado, idDaRequisicao, ts }) {
  // Partes ausentes saem do manifesto, como o Mercado Pago faz ao assinar.
  let manifesto = '';
  if (idDoDado) manifesto += `id:${String(idDoDado).toLowerCase()};`;
  if (idDaRequisicao) manifesto += `request-id:${idDaRequisicao};`;
  manifesto += `ts:${ts};`;
  return manifesto;
}

/**
 * @param {object} n
 * @param {string|undefined} n.cabecalhoAssinatura valor de `x-signature`
 * @param {string|undefined} n.idDaRequisicao valor de `x-request-id`
 * @param {string|undefined} n.idDoDado `data.id` da query string
 * @param {string|undefined} n.segredo chave secreta configurada no painel
 * @returns {{valida: boolean, motivo: string|null}}
 */
function verificarAssinatura({ cabecalhoAssinatura, idDaRequisicao, idDoDado, segredo }) {
  if (!segredo) {
    return { valida: false, motivo: 'sem_segredo' };
  }
  if (!cabecalhoAssinatura) {
    return { valida: false, motivo: 'cabecalho_ausente' };
  }

  const { ts, v1 } = lerCabecalho(cabecalhoAssinatura);
  if (!ts || !v1 || !HEX_DE_SHA256.test(v1)) {
    return { valida: false, motivo: 'cabecalho_malformado' };
  }
  if (!idDoDado) {
    return { valida: false, motivo: 'dados_ausentes' };
  }

  const esperada = crypto
    .createHmac('sha256', segredo)
    .update(montarManifesto({ idDoDado, idDaRequisicao, ts }))
    .digest();
  const recebida = Buffer.from(v1, 'hex');

  // Comparação em tempo constante: com `===`, o tempo de resposta vazaria
  // quantos caracteres iniciais da assinatura estão certos. Os tamanhos são
  // iguais aqui — o formato foi validado acima —, mas a checagem fica, porque
  // timingSafeEqual lança com tamanhos diferentes.
  const confere = recebida.length === esperada.length && crypto.timingSafeEqual(recebida, esperada);

  return confere ? { valida: true, motivo: null } : { valida: false, motivo: 'assinatura_nao_confere' };
}

module.exports = { verificarAssinatura };
