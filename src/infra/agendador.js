'use strict';

/**
 * Executa uma tarefa em intervalo fixo — hoje, a expiração de reservas.
 *
 * Três cuidados:
 *   - nunca duas execuções ao mesmo tempo: se uma rodada demorar mais que o
 *     intervalo (o provedor de pagamento lento, por exemplo), a seguinte é
 *     pulada, em vez de se sobrepor;
 *   - um erro numa rodada é registrado e não derruba o processo nem as rodadas
 *     seguintes;
 *   - os temporizadores não seguram o processo vivo (`unref`): quem decide
 *     quando a API termina é o desligamento do servidor.
 *
 * Só `servidor.js` liga rotinas. O app montado nos testes não tem nenhuma —
 * um temporizador rodando no fundo de um teste mexeria no banco sem ninguém
 * pedir.
 */

function agendar(tarefa, intervaloMs, { nome, aoTerminar = () => {} } = {}) {
  let rodando = false;
  let parado = false;

  async function rodar() {
    if (rodando || parado) return;
    rodando = true;
    try {
      aoTerminar(await tarefa());
    } catch (erro) {
      console.error(`Rotina "${nome}" falhou:`, erro.message);
    } finally {
      rodando = false;
    }
  }

  const temporizador = setInterval(rodar, intervaloMs);
  temporizador.unref();
  // Uma primeira rodada logo na subida: depois de hibernar, a API acorda com
  // reservas vencidas esperando, e não há por que aguardar um intervalo inteiro.
  setTimeout(rodar, 0).unref();

  return {
    parar() {
      parado = true;
      clearInterval(temporizador);
    },
    rodarAgora: rodar,
  };
}

module.exports = { agendar };
