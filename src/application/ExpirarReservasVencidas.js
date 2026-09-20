'use strict';

/**
 * Caso de uso: devolver à grade os horários de reservas não pagas.
 *
 * Sem esta rotina, um checkout abandonado prenderia o horário até a data da
 * consulta. Ela roda a cada minuto enquanto a API está de pé.
 *
 * RECONCILIAÇÃO. Antes de expirar uma reserva que teve checkout, a rotina
 * pergunta ao provedor se houve pagamento com aquela referência. No plano
 * gratuito de hospedagem a API hiberna, e o aviso do provedor pode se perder;
 * sem esta pergunta, alguém que pagou teria a consulta cancelada. A pergunta
 * acontece FORA de transação — segurar bloqueio do banco esperando rede
 * travaria o agendamento — e a expiração em si refaz a decisão sob bloqueio.
 *
 * Se o provedor não responder, a expiração daquela reserva é adiada para a
 * próxima rodada — mas não para sempre: passado o ADIAMENTO_MAXIMO_MS do
 * vencimento, ela expira assim mesmo, e um pagamento que apareça depois vira
 * anomalia para estorno. Uma queda longa do provedor não pode prender horários
 * indefinidamente.
 */

const { PagamentoIndisponivel } = require('../domain/erros');
const { relogioDoSistema } = require('../domain/Relogio');

const ADIAMENTO_MAXIMO_MS = 30 * 60_000;

class ExpirarReservasVencidas {
  constructor({ consultas, pagamentos, gateway, relogio = relogioDoSistema, limite = 50 }) {
    this.consultas = consultas;
    this.pagamentos = pagamentos;
    this.gateway = gateway;
    this.relogio = relogio;
    this.limite = limite;
  }

  /** @returns {Promise<{expiradas: number, confirmadas: number, adiadas: number, falhas: number}>} */
  async executar() {
    const agora = this.relogio.agora();
    const candidatas = await this.consultas.reservasVencidas(agora, this.limite);
    const resultado = { expiradas: 0, confirmadas: 0, adiadas: 0, falhas: 0 };

    for (const candidata of candidatas) {
      try {
        const reconciliada = await this.reconciliar(candidata, agora);
        if (reconciliada === 'confirmada') {
          resultado.confirmadas += 1;
          continue;
        }
        if (reconciliada === 'adiada') {
          resultado.adiadas += 1;
          continue;
        }
        if (await this.consultas.expirarSeVencida(candidata.consultaId, agora)) {
          resultado.expiradas += 1;
        }
      } catch (erro) {
        // Uma reserva problemática não impede as outras de expirar.
        resultado.falhas += 1;
        console.error(`Expiração da consulta ${candidata.consultaId} falhou:`, erro.message);
      }
    }

    return resultado;
  }

  /** @returns {Promise<'confirmada'|'adiada'|'seguir'>} */
  async reconciliar({ consultaId, referencias, reservaExpiraEm }, agora) {
    for (const referencia of referencias) {
      let encontrados;
      try {
        encontrados = await this.gateway.pagamentosDaReferencia(referencia);
      } catch (erro) {
        if (!(erro instanceof PagamentoIndisponivel)) throw erro;
        const venceuHa = agora.getTime() - new Date(reservaExpiraEm).getTime();
        if (venceuHa < ADIAMENTO_MAXIMO_MS) return 'adiada';
        console.warn(
          `Consulta ${consultaId}: provedor fora do ar há mais de ` +
            `${ADIAMENTO_MAXIMO_MS / 60_000} min depois do vencimento; expirando sem reconciliar.`
        );
        return 'seguir';
      }

      for (const pagamento of encontrados) {
        const aplicado = await this.pagamentos.aplicarPagamento(pagamento, { ator: 'sistema' });
        if (aplicado.desfecho === 'consulta_confirmada') return 'confirmada';
      }
    }
    return 'seguir';
  }
}

module.exports = { ExpirarReservasVencidas, ADIAMENTO_MAXIMO_MS };
