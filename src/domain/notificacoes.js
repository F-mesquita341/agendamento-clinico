'use strict';

/**
 * Contrato do envio de notificação push, declarado no domínio — mesma inversão
 * de dependência de ./repositorios.js e ./pagamentos.js.
 *
 * O provedor (Firebase Cloud Messaging) fica atrás de `ServicoDeNotificacao`:
 * o caso de uso não sabe que ele existe, e os testes trocam o provedor por um
 * dublê sem rede.
 */

function naoImplementado(metodo) {
  throw new Error(`${metodo} precisa ser implementado pelo adaptador concreto.`);
}

class ServicoDeNotificacao {
  /**
   * Envia a mesma mensagem para vários aparelhos.
   *
   * O resultado separa duas coisas que parecem uma só: quantos receberam, e
   * quais tokens o provedor disse que **não existem mais** — aplicativo
   * desinstalado, token expirado. Só esses são apagados. Falha de rede ou
   * indisponibilidade do provedor NÃO entram em `invalidos`: apagar um token
   * bom por causa de uma queda momentânea deixaria o paciente sem lembrete
   * para sempre, e ninguém perceberia.
   *
   * @param {{tokens: Array<string>, titulo: string, corpo: string,
   *          dados?: Record<string, string>}} _mensagem
   * @returns {Promise<{entregues: number, invalidos: Array<string>}>}
   */
  async enviar(_mensagem) {
    naoImplementado('ServicoDeNotificacao.enviar');
  }
}

module.exports = { ServicoDeNotificacao };
