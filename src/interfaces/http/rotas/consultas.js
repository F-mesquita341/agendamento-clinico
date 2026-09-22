'use strict';

/**
 * Rotas de consultas.
 *
 *   POST  /consultas                    agenda, com a versão lida da grade
 *   GET   /consultas                    lista as do paciente autenticado
 *   GET   /consultas/:id                detalhe de uma consulta própria
 *   PATCH /consultas/:id/cancelamento   cancela e devolve o horário à grade
 *   POST  /consultas/:id/pagamento      abre (ou reaproveita) o checkout
 *
 * O paciente vem sempre do token, via `carregarPaciente` — nenhuma rota aceita
 * id de paciente. Um id de CONSULTA na URL é inevitável, e por isso o dono é
 * verificado em toda leitura e escrita. Consulta de outra pessoa responde 404,
 * igual a consulta inexistente — ver `semRevelarExistencia`, abaixo.
 *
 * Fábrica, como em rotas/pacientes.js, porque o verificador de token é
 * injetado: o real em produção, um falso nos testes.
 */

const { Router } = require('express');
const { z } = require('zod');

const config = require('../../../config');
const { AgendarConsulta } = require('../../../application/AgendarConsulta');
const { CancelarConsulta } = require('../../../application/CancelarConsulta');
const { IniciarPagamento } = require('../../../application/IniciarPagamento');
const { RepositorioDePagamentosPg } = require('../../../infra/db/RepositorioDePagamentosPg');
const { RepositorioDeHorariosPg } = require('../../../infra/db/RepositorioDeHorariosPg');
const { RepositorioDeConsultasPg } = require('../../../infra/db/RepositorioDeConsultasPg');
const { RepositorioDePacientesPg } = require('../../../infra/db/RepositorioDePacientesPg');
const { NaoEncontrado, AcessoNegado } = require('../../../domain/erros');
const { criarAutenticar } = require('../middlewares/autenticar');
const { criarCarregarPaciente } = require('../middlewares/carregarPaciente');
const { semCache } = require('../middlewares/semCache');
const { validar } = require('../validacao');
const { objetoEstrito, inteiroPositivo, inteiroPositivoEmCorpo } = require('../esquemas');
const apresentar = require('../apresentadores');

const LIMITE_PADRAO = 20;

/** `horario.versao` é INTEGER no banco; acima disso o PostgreSQL recusa. */
const MAIOR_VERSAO = 2_147_483_647;

const corpoDoAgendamento = objetoEstrito(
  {
    horarioId: inteiroPositivoEmCorpo('O horário'),
    // Zero é versão legítima — todo horário nasce na versão 0 —, então aqui
    // não serve `inteiroPositivoEmCorpo`.
    versao: z
      .number({
        required_error: 'A versão do horário é obrigatória. Recarregue a lista de horários.',
        invalid_type_error: 'A versão do horário precisa ser um número inteiro.',
      })
      .int('A versão do horário precisa ser um número inteiro.')
      .min(0, 'A versão do horário precisa ser um número inteiro.')
      .max(MAIOR_VERSAO, 'Versão de horário inexistente. Recarregue a lista de horários.'),
  },
  'O corpo do agendamento'
);

const idNaRota = z.object({ id: inteiroPositivo('O identificador') });

const paginacao = z.object({
  pagina: inteiroPositivo('A página').default(1),
  limite: inteiroPositivo('O limite')
    .max(100, 'O limite máximo por página é 100.')
    .default(LIMITE_PADRAO),
});

/**
 * Consulta de outro paciente responde 404, não 403.
 *
 * O dono legítimo nunca receberia 403, então distinguir "existe, mas não é seu"
 * de "não existe" não informa nada a quem tem direito à informação — e permite
 * que qualquer paciente autenticado percorra /consultas/1..N e descubra quantos
 * registros de saúde a clínica tem, e com que ritmo eles crescem.
 *
 * O domínio continua falando em `AcessoNegado`, que é o que de fato aconteceu;
 * não revelar a existência é política da fronteira HTTP, e é aqui que ela mora.
 */
function semRevelarExistencia(erro) {
  return erro instanceof AcessoNegado ? new NaoEncontrado('Consulta') : erro;
}

function criarRotasDeConsultas({
  verificarToken,
  gateway,
  pacientes = new RepositorioDePacientesPg(),
  horarios = new RepositorioDeHorariosPg(),
  consultas = new RepositorioDeConsultasPg(),
  pagamentos = new RepositorioDePagamentosPg(),
  relogio,
}) {
  const rotas = Router();
  const autenticar = criarAutenticar(verificarToken);
  const carregarPaciente = criarCarregarPaciente(pacientes);
  const comRelogio = relogio ? { relogio } : {};

  const agendar = new AgendarConsulta({
    horarios,
    consultas,
    reservaMinutos: config.RESERVA_MINUTOS,
    ...comRelogio,
  });
  const cancelar = new CancelarConsulta({ consultas });
  const iniciarPagamento = new IniciarPagamento({ consultas, pagamentos, gateway, ...comRelogio });

  rotas.use(semCache);

  rotas.use(autenticar, carregarPaciente);

  rotas.post('/', async (req, res, next) => {
    try {
      const corpo = validar(corpoDoAgendamento, req.body);
      const consulta = await agendar.executar({
        pacienteId: req.paciente.id,
        horarioId: corpo.horarioId,
        versao: corpo.versao,
      });

      res
        .status(201)
        .location(`/consultas/${consulta.id}`)
        .json({ consulta: apresentar.consulta(consulta) });
    } catch (erro) {
      next(erro);
    }
  });

  rotas.get('/', async (req, res, next) => {
    try {
      const { pagina, limite } = validar(paginacao, req.query);

      const { itens, total } = await consultas.doPaciente({
        pacienteId: req.paciente.id,
        limite,
        deslocamento: (pagina - 1) * limite,
      });

      res.json({
        consultas: itens.map((leitura) => apresentar.consulta(leitura.consulta, leitura)),
        paginacao: {
          pagina,
          limite,
          total,
          paginas: Math.max(1, Math.ceil(total / limite)),
        },
      });
    } catch (erro) {
      next(erro);
    }
  });

  rotas.get('/:id', async (req, res, next) => {
    try {
      const { id } = validar(idNaRota, req.params);

      const leitura = await consultas.leituraPorId(id);
      if (!leitura) {
        throw new NaoEncontrado('Consulta');
      }
      if (!leitura.consulta.pertenceAo(req.paciente.id)) {
        throw new AcessoNegado('Esta consulta pertence a outro paciente.');
      }

      res.json({ consulta: apresentar.consulta(leitura.consulta, leitura) });
    } catch (erro) {
      next(semRevelarExistencia(erro));
    }
  });

  rotas.patch('/:id/cancelamento', async (req, res, next) => {
    try {
      const { id } = validar(idNaRota, req.params);

      const consulta = await cancelar.executar({
        pacienteId: req.paciente.id,
        consultaId: id,
      });

      res.json({ consulta: apresentar.consulta(consulta) });
    } catch (erro) {
      next(semRevelarExistencia(erro));
    }
  });

  rotas.post('/:id/pagamento', async (req, res, next) => {
    try {
      const { id } = validar(idNaRota, req.params);

      const { checkout, consulta, novo } = await iniciarPagamento.executar({
        pacienteId: req.paciente.id,
        consultaId: id,
      });

      // 201 quando o checkout nasceu agora; 200 quando é o mesmo de antes.
      res.status(novo ? 201 : 200).json({ pagamento: apresentar.checkout(checkout, consulta) });
    } catch (erro) {
      next(semRevelarExistencia(erro));
    }
  });

  return rotas;
}

module.exports = { criarRotasDeConsultas };
