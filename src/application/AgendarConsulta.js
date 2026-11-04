'use strict';

/**
 * Caso de uso: agendar uma consulta.
 *
 * É o coração do trabalho. Recebe seus colaboradores pelo construtor — nada de
 * `require` de banco aqui dentro —, então roda inteiro contra repositórios
 * falsos em memória, sem PostgreSQL e sem rede.
 *
 * Ordem deliberada:
 *
 *   1. valida o que dá para validar cedo, para produzir mensagens boas;
 *   2. delega a reserva atômica ao repositório, que compara a versão dentro de
 *      uma transação;
 *   3. traduz "a versão não conferia" em 409.
 *
 * Os passos 1 e 2 NÃO são atômicos entre si, e isso é intencional: entre a
 * verificação e a escrita existe uma janela em que outra pessoa pode reservar
 * o mesmo horário. Quem garante exclusividade é o lock otimista do passo 2 —
 * as checagens do passo 1 servem para explicar melhor os casos previsíveis.
 */

const {
  NaoEncontrado,
  HorarioIndisponivel,
  RegraDeNegocio,
  ConsultaSobreposta,
} = require('../domain/erros');
const { relogioDoSistema } = require('../domain/Relogio');
const { FORMA_DE_PAGAMENTO, FORMAS } = require('../domain/formasDePagamento');

class AgendarConsulta {
  /**
   * @param {object} deps
   * @param {import('../domain/repositorios').RepositorioDeHorarios} deps.horarios
   * @param {import('../domain/repositorios').RepositorioDeConsultas} deps.consultas
   * @param {{agora: () => Date}} [deps.relogio]
   * @param {number} [deps.reservaMinutos] minutos até a reserva não paga expirar
   */
  constructor({ horarios, consultas, relogio = relogioDoSistema, reservaMinutos = 15 }) {
    this.horarios = horarios;
    this.consultas = consultas;
    this.relogio = relogio;
    this.reservaMinutos = reservaMinutos;
  }

  /**
   * @param {object} pedido
   * @param {string} [pedido.formaDePagamento] versão 2: 'app' (padrão),
   *        'plano' ou 'clinica'. Se o profissional aceita a forma, quem
   *        confere é o repositório, dentro da transação da reserva.
   * @param {number} [pedido.planoId] só com a forma 'plano'
   */
  async executar({
    pacienteId,
    horarioId,
    versao,
    formaDePagamento = FORMA_DE_PAGAMENTO.APP,
    planoId = null,
  }) {
    if (pacienteId == null || horarioId == null) {
      throw new RegraDeNegocio(
        'DADOS_INCOMPLETOS',
        'Informe o paciente e o horário desejado.'
      );
    }
    // A fronteira HTTP já recusa estas combinações com a lista de campos;
    // aqui é a guarda de quem chamar o caso de uso por outro caminho.
    if (!FORMAS.includes(formaDePagamento)) {
      throw new RegraDeNegocio('DADOS_INCOMPLETOS', 'Forma de pagamento desconhecida.');
    }
    if ((formaDePagamento === FORMA_DE_PAGAMENTO.PLANO) !== (planoId != null)) {
      throw new RegraDeNegocio(
        'DADOS_INCOMPLETOS',
        'O plano é informado só, e sempre, quando a forma de pagamento é o plano.'
      );
    }
    if (!Number.isInteger(versao)) {
      throw new RegraDeNegocio(
        'VERSAO_AUSENTE',
        'A versão do horário é obrigatória. Recarregue a lista de horários.'
      );
    }

    const agora = this.relogio.agora();

    const horario = await this.horarios.porId(horarioId);
    if (!horario) {
      throw new NaoEncontrado('Horário');
    }

    // Lança HORARIO_NO_PASSADO ou HORARIO_INDISPONIVEL.
    horario.garantirQuePodeSerReservado(agora);

    // O paciente não pode estar em dois lugares ao mesmo tempo.
    //
    // Esta leitura acontece fora da transação e, sozinha, não garante nada: dois
    // pedidos simultâneos para horários diferentes e sobrepostos passam por aqui
    // juntos. Quem garante é a restrição de exclusão `consulta_sem_sobreposicao`
    // (migration 007), que o adaptador traduz no mesmo erro — a checagem daqui
    // existe para recusar cedo o caso comum, sem tocar no banco para escrever.
    const conflito = await this.consultas.existeAtivaNoIntervalo(
      pacienteId,
      horario.inicio,
      horario.fim
    );
    if (conflito) {
      throw new ConsultaSobreposta();
    }

    // Só o pagamento pelo aplicativo tem prazo de reserva: plano e clínica
    // nascem confirmados.
    const expiraEm =
      formaDePagamento === FORMA_DE_PAGAMENTO.APP
        ? new Date(agora.getTime() + this.reservaMinutos * 60_000)
        : null;

    // O valor NÃO é informado aqui: ele é lido do profissional pelo adaptador,
    // dentro da mesma transação, e gravado na consulta. Duas razões — o preço
    // é atributo do profissional, não do horário; e congelá-lo no ato garante
    // que um reajuste posterior não altere consultas já marcadas.
    const consulta = await this.horarios.reservarEAgendar({
      horarioId: horario.id,
      versao,
      pacienteId,
      reservaExpiraEm: expiraEm,
      formaDePagamento,
      planoId,
    });

    // null significa que o UPDATE não afetou nenhuma linha: entre a leitura da
    // grade e este instante, outra pessoa reservou. Caminho esperado.
    if (!consulta) {
      throw new HorarioIndisponivel();
    }

    return consulta;
  }
}

module.exports = { AgendarConsulta };
