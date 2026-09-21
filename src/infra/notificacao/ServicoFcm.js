'use strict';

/**
 * Adaptador do Firebase Cloud Messaging.
 *
 * Nenhuma credencial nova: a mesma conta de serviço que verifica o token de
 * autenticação envia a notificação, pelo app compartilhado em ../firebase/app.
 *
 * O que sai daqui é só o que o domínio montou — título e corpo, sem
 * especialidade nem nome de profissional (ver domain/Lembrete.js). O adaptador
 * não acrescenta nada ao texto.
 */

const { ServicoDeNotificacao } = require('../../domain/notificacoes');
const { obterAppDoFirebase } = require('../firebase/app');

/**
 * Códigos do FCM que significam "este token não existe mais": aplicativo
 * desinstalado, token expirado, aparelho trocado.
 *
 * A lista é FECHADA de propósito, pelo mesmo motivo da lista de códigos do
 * verificador de token: qualquer outro erro — rede fora, cota, provedor
 * instável — é problema momentâneo. Apagar um token bom por causa de uma queda
 * deixaria o paciente sem lembrete para sempre, e ninguém perceberia, porque
 * não há erro depois disso: simplesmente não há mais para onde enviar.
 */
const TOKEN_MORTO = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

class ServicoFcm extends ServicoDeNotificacao {
  /**
   * @param {object} [opcoes]
   * @param {{sendEachForMulticast: Function}} [opcoes.messaging] instância do
   *        Firebase Messaging; informada apenas nos testes do próprio adaptador.
   */
  constructor({ messaging } = {}) {
    super();
    this.mensageiro = messaging ?? null;
  }

  obterMensageiro() {
    if (!this.mensageiro) {
      const { getMessaging } = require('firebase-admin/messaging');
      this.mensageiro = getMessaging(obterAppDoFirebase());
    }
    return this.mensageiro;
  }

  async enviar({ tokens, titulo, corpo, dados = {} }) {
    if (!tokens || tokens.length === 0) {
      return { entregues: 0, invalidos: [] };
    }

    const resposta = await this.obterMensageiro().sendEachForMulticast({
      tokens,
      notification: { title: titulo, body: corpo },
      // O FCM só aceita texto aqui. São identificadores internos, para o
      // aplicativo saber que tela abrir — nada descritivo.
      data: Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, String(v)])),
    });

    // A resposta vem na MESMA ordem dos tokens enviados; é assim que se sabe
    // qual token causou qual erro.
    const invalidos = [];
    resposta.responses.forEach((resultado, i) => {
      if (resultado.success) return;
      const codigo = resultado.error?.code;
      if (TOKEN_MORTO.has(codigo)) {
        invalidos.push(tokens[i]);
      } else {
        // Falha momentânea: o token continua valendo e a próxima rodada tenta.
        console.warn(`FCM recusou um envio: ${codigo ?? 'sem código'}`);
      }
    });

    return { entregues: resposta.successCount, invalidos };
  }
}

/**
 * Sem credencial do Firebase, não há como enviar. Responde "nada entregue" em
 * vez de estourar: é o mesmo caminho do `GatewayNaoConfigurado`, e permite a
 * API subir em desenvolvimento sem credencial. Em produção, config.js já
 * recusou a subida sem ela.
 */
class ServicoNaoConfigurado extends ServicoDeNotificacao {
  async enviar() {
    console.warn('Notificação não enviada: Firebase não configurado neste ambiente.');
    return { entregues: 0, invalidos: [] };
  }
}

module.exports = { ServicoFcm, ServicoNaoConfigurado, TOKEN_MORTO };
