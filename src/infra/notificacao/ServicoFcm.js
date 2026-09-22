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
const { relogioDoSistema } = require('../../domain/Relogio');
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
]);

/*
 * `messaging/invalid-argument` NÃO está na lista, e chegou a estar.
 *
 * Ele quase sempre significa token malformado — mas também é o que o FCM
 * devolve quando a MENSAGEM é inválida. E a mensagem é a mesma para todos os
 * aparelhos: um defeito nosso no payload faria todos falharem com esse código
 * e apagaríamos, de uma vez, todos os aparelhos do paciente. Um erro nosso
 * viraria perda de dado de quem não tem nada com isso.
 *
 * Deixá-lo de fora custa tokens mortos sobrando na tabela até o FCM devolver um
 * dos dois códigos específicos. É o lado barato de errar.
 */

class ServicoFcm extends ServicoDeNotificacao {
  /**
   * @param {object} [opcoes]
   * @param {{sendEachForMulticast: Function}} [opcoes.messaging] instância do
   *        Firebase Messaging; informada apenas nos testes do próprio adaptador.
   */
  constructor({ messaging, relogio = relogioDoSistema } = {}) {
    super();
    this.mensageiro = messaging ?? null;
    this.relogio = relogio;
  }

  obterMensageiro() {
    if (!this.mensageiro) {
      const { getMessaging } = require('firebase-admin/messaging');
      this.mensageiro = getMessaging(obterAppDoFirebase());
    }
    return this.mensageiro;
  }

  async enviar({ tokens, titulo, corpo, dados = {}, expiraEm = null }) {
    const agora = this.relogio.agora();
    if (!tokens || tokens.length === 0) {
      return { entregues: 0, invalidos: [] };
    }

    const mensagem = {
      notification: { title: titulo, body: corpo },
      // O FCM só aceita texto aqui. São identificadores internos, para o
      // aplicativo saber que tela abrir — nada descritivo.
      data: Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, String(v)])),
      ...validadeAte(expiraEm, agora),
    };

    // O FCM aceita no máximo 500 destinos por chamada, e ESTOURA acima disso.
    // Sem os lotes, um paciente com mais aparelhos que isso travaria o lembrete
    // num ciclo sem fim: reserva, falha, desmarca, a cada rodada.
    let entregues = 0;
    const invalidos = [];
    for (let inicio = 0; inicio < tokens.length; inicio += LOTE_MAXIMO) {
      const lote = tokens.slice(inicio, inicio + LOTE_MAXIMO);
      const resposta = await this.obterMensageiro().sendEachForMulticast({ ...mensagem, tokens: lote });

      // A resposta vem na MESMA ordem dos tokens do lote; é assim que se sabe
      // qual token causou qual erro.
      resposta.responses.forEach((resultado, i) => {
        if (resultado.success) return;
        const codigo = resultado.error?.code;
        if (TOKEN_MORTO.has(codigo)) {
          invalidos.push(lote[i]);
        } else {
          // Falha momentânea: o token continua valendo e a próxima rodada tenta.
          console.warn(`FCM recusou um envio: ${codigo ?? 'sem código'}`);
        }
      });
      entregues += resposta.successCount;
    }

    return { entregues, invalidos };
  }
}

const LOTE_MAXIMO = 500;

/**
 * Até quando a mensagem vale, nas três plataformas — cada uma com seu formato.
 *
 * Sem isso o FCM guarda a mensagem por até quatro semanas para aparelho
 * desligado, e o lembrete de uma consulta poderia chegar depois dela. Com o
 * prazo, a mensagem que não alcançou o aparelho a tempo simplesmente morre.
 */
function validadeAte(expiraEm, agora) {
  if (!expiraEm) return {};
  const restanteMs = Math.max(0, new Date(expiraEm).getTime() - agora.getTime());
  return {
    android: { ttl: restanteMs },
    webpush: { headers: { TTL: String(Math.floor(restanteMs / 1000)) } },
    apns: { headers: { 'apns-expiration': String(Math.floor(new Date(expiraEm).getTime() / 1000)) } },
  };
}

/**
 * Sem credencial do Firebase, não há como enviar — e isso ESTOURA, em vez de
 * responder "zero entregues".
 *
 * Responder zero parecia inofensivo e não era: a rotina de lembretes entenderia
 * "ninguém recebeu", manteria a marca, e aquela consulta nunca mais seria
 * lembrada, mesmo depois de o Firebase ser configurado. Estourando, a rotina
 * desfaz a marca e a consulta volta à fila. Na prática `servidor.js` nem liga a
 * rotina sem credencial; isto garante que ninguém a ligue por engano.
 */
class ServicoNaoConfigurado extends ServicoDeNotificacao {
  async enviar() {
    throw new Error('Notificação não enviada: Firebase não configurado neste ambiente.');
  }
}

module.exports = { ServicoFcm, ServicoNaoConfigurado, TOKEN_MORTO, LOTE_MAXIMO };
