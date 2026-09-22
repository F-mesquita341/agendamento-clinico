'use strict';

/**
 * Caso de uso: avisar quem tem consulta nas próximas 24 horas.
 *
 * A Seção 3.2 do projeto aponta o lembrete automatizado entre as intervenções
 * de maior efetividade documentada contra o absenteísmo, ao lado do pagamento
 * prévio. É a segunda das duas que o trabalho incorpora.
 *
 * ORDEM DAS OPERAÇÕES, que é onde mora a dificuldade. Para cada consulta:
 *
 *   1. reservar sob bloqueio — marca `lembrete_enviado_em` e devolve o que
 *      falta; se outra rodada já marcou, ou a consulta foi cancelada, devolve
 *      null e esta rodada a ignora;
 *   2. buscar os aparelhos e enviar FORA da transação — segurar bloqueio do
 *      banco esperando rede travaria o agendamento, mesma regra da
 *      reconciliação de pagamento;
 *   3. apagar os tokens que o provedor disse não existirem mais, e auditar —
 *      DEPOIS do envio, e sem poder desfazer a marca: falha aqui não pode
 *      virar reenvio de um lembrete que já foi entregue;
 *   4. se o ENVIO falhou por motivo momentâneo, desfazer a marca, para a
 *      rodada seguinte tentar.
 *
 * Marcar ANTES de enviar troca o risco de duplicata pelo risco de perda. É
 * deliberado: o portão da etapa exige que o lembrete chegue uma única vez, e
 * uma notificação repetida é pior, para quem recebe, do que uma que atrasa.
 */

const { textoDoLembrete } = require('../domain/Lembrete');
const { relogioDoSistema } = require('../domain/Relogio');

class EnviarLembretes {
  constructor({ consultas, dispositivos, notificador, relogio = relogioDoSistema, limite = 50 }) {
    this.consultas = consultas;
    this.dispositivos = dispositivos;
    this.notificador = notificador;
    this.relogio = relogio;
    this.limite = limite;
  }

  /** @returns {Promise<{enviados: number, semAparelho: number, adiados: number, falhas: number}>} */
  async executar() {
    const agora = this.relogio.agora();
    const candidatas = await this.consultas.aguardandoLembrete(agora, this.limite);
    const resultado = { enviados: 0, semAparelho: 0, adiados: 0, falhas: 0 };

    for (const consultaId of candidatas) {
      // Só desfaz a marca quem a gravou. Se o próprio `reservarLembrete`
      // falhar, não há marca nossa para desfazer, e chamar `desmarcarLembrete`
      // ali seria apagar uma marca de origem desconhecida.
      let reservada = null;
      try {
        reservada = await this.consultas.reservarLembrete(consultaId, agora);
        // Outra rodada chegou primeiro, ou a consulta mudou de estado entre a
        // varredura e o bloqueio.
        if (!reservada) continue;

        if (await this.avisar(reservada, agora)) {
          resultado.enviados += 1;
        } else {
          resultado.semAparelho += 1;
        }
      } catch (erro) {
        // O envio falhou por motivo momentâneo: devolve a consulta à fila.
        // Uma consulta problemática não impede as outras de serem avisadas.
        resultado.adiados += 1;
        console.error(`Lembrete da consulta ${consultaId} adiado:`, erro.message);
        if (!reservada) continue;
        try {
          await this.consultas.desmarcarLembrete(consultaId);
        } catch (aoDesmarcar) {
          // Aqui a marca fica de pé e o lembrete se perde. É o pior desfecho
          // possível desta rotina, e por isso aparece separado na contagem.
          resultado.falhas += 1;
          console.error(
            `Consulta ${consultaId}: não foi possível desfazer a marca do lembrete:`,
            aoDesmarcar.message
          );
        }
      }
    }

    return resultado;
  }

  /** @returns {Promise<boolean>} se havia aparelho para avisar */
  async avisar({ consultaId, pacienteId, inicio }, agora) {
    const tokens = await this.dispositivos.doPaciente(pacienteId);
    if (tokens.length === 0) {
      // Paciente sem aplicativo instalado. A marca fica: não há o que reenviar,
      // e tentar de novo a cada rodada seria varrer a mesma consulta para
      // sempre.
      return false;
    }

    const { titulo, corpo } = textoDoLembrete(new Date(inicio), agora);
    // Se ESTE envio falhar, o erro sobe e a marca é desfeita: nada saiu, e a
    // rodada seguinte tenta de novo.
    const { entregues, invalidos } = await this.notificador.enviar({
      tokens,
      titulo,
      corpo,
      // Só o identificador interno, para o aplicativo saber que tela abrir.
      dados: { consultaId: String(consultaId), tipo: 'lembrete' },
      // Depois do começo da consulta, o lembrete não serve mais para nada.
      expiraEm: new Date(inicio),
    });

    // DAQUI EM DIANTE O LEMBRETE JÁ SAIU. Nenhuma falha abaixo pode subir: ela
    // cairia no `catch` de `executar`, que desfaria a marca, e a rodada
    // seguinte mandaria o mesmo lembrete de novo — a duplicata que o portão da
    // etapa proíbe. Apagar token morto e auditar são contabilidade; se falharem,
    // o log diz, e a marca fica de pé.
    await this.contabilizar(consultaId, { entregues, invalidos });

    // Todos os aparelhos estavam mortos: ninguém recebeu. Contar como enviado
    // seria registrar entrega que não houve. A marca fica de pé: os tokens
    // acabaram de ser apagados, não há o que reenviar.
    return entregues > 0;
  }

  async contabilizar(consultaId, { entregues, invalidos }) {
    try {
      if (invalidos.length > 0) {
        await this.dispositivos.esquecer(invalidos);
      }
      if (entregues > 0) {
        await this.consultas.registrarLembreteEnviado(consultaId, entregues);
      }
    } catch (erro) {
      console.error(
        `Lembrete da consulta ${consultaId} ENTREGUE, mas o registro falhou ` +
          '(a marca foi mantida para não reenviar):',
        erro.message
      );
    }
  }
}

module.exports = { EnviarLembretes };
