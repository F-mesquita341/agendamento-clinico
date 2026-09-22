'use strict';

/**
 * Rotas dos aparelhos que recebem notificação push.
 *
 *   POST   /dispositivos      registra o aparelho da conta autenticada → { id }
 *   DELETE /dispositivos/:id  revoga o aparelho
 *
 * Como em `/pacientes/me`, nenhuma rota recebe id de paciente: o dono é sempre
 * o do token verificado.
 *
 * O TOKEN DO APARELHO NÃO VAI NA URL. Ele identifica o telefone — é dado
 * pessoal —, e o caminho da URL é o lugar mais registrado de uma requisição:
 * log de acesso da hospedagem, proxies, histórico. A revogação usa o id que o
 * registro devolve. Receber o token no corpo do DELETE também o tiraria da URL,
 * mas corpo em DELETE não tem significado definido no HTTP e pode ser
 * descartado no caminho.
 *
 * Revogar aparelho que não é seu responde 404, e não 403: com 403, dava para
 * descobrir quais ids existem mandando tentativas. Com 404, não existe e não é
 * seu são indistinguíveis de fora.
 */

const { Router } = require('express');
const { z } = require('zod');

const { RepositorioDeDispositivosPg } = require('../../../infra/db/RepositorioDeDispositivosPg');
const { RepositorioDePacientesPg } = require('../../../infra/db/RepositorioDePacientesPg');
const { NaoEncontrado } = require('../../../domain/erros');
const { criarAutenticar } = require('../middlewares/autenticar');
const { criarCarregarPaciente } = require('../middlewares/carregarPaciente');
const { semCache } = require('../middlewares/semCache');
const { validar } = require('../validacao');
const { objetoEstrito, inteiroPositivo } = require('../esquemas');

const PLATAFORMAS = ['android', 'ios', 'web'];
const MENSAGEM_DA_PLATAFORMA = `Informe a plataforma do aparelho: ${PLATAFORMAS.join(', ')}.`;

const corpoDoRegistro = objetoEstrito(
  {
    token: z
      .string({ required_error: 'Informe o token do aparelho.', invalid_type_error: 'O token precisa ser um texto.' })
      .trim()
      .min(1, 'Informe o token do aparelho.')
      // Tokens do Firebase passam de 150 caracteres; o limite é folgado de
      // propósito, só para impedir corpo absurdo.
      .max(4096, 'O token do aparelho é longo demais.'),
    // `errorMap`, e não `invalid_type_error`: esta só vale para entrada que não
    // é texto. Um texto fora da lista — 'symbian' — caía na mensagem padrão do
    // zod, em inglês, e o aplicativo a mostraria ao paciente.
    plataforma: z.enum(PLATAFORMAS, { errorMap: () => ({ message: MENSAGEM_DA_PLATAFORMA }) }),
  },
  'O corpo do registro do aparelho'
);

const idNaRota = z.object({ id: inteiroPositivo('O identificador do aparelho') });

function criarRotasDeDispositivos({
  verificarToken,
  pacientes = new RepositorioDePacientesPg(),
  dispositivos = new RepositorioDeDispositivosPg(),
}) {
  const rotas = Router();
  const autenticar = criarAutenticar(verificarToken);
  const carregarPaciente = criarCarregarPaciente(pacientes);

  rotas.use(semCache);

  rotas.post('/', autenticar, carregarPaciente, async (req, res, next) => {
    try {
      const { token, plataforma } = validar(corpoDoRegistro, req.body);
      const { id } = await dispositivos.registrar({ pacienteId: req.paciente.id, token, plataforma });
      // Devolve o id, que é o que o aplicativo guarda para revogar ao sair. O
      // token não volta: quem enviou já o tem, e repeti-lo só o faria existir
      // em mais um lugar.
      res.status(201).json({ dispositivo: { id } });
    } catch (erro) {
      next(erro);
    }
  });

  rotas.delete('/:id', autenticar, carregarPaciente, async (req, res, next) => {
    try {
      const { id } = validar(idNaRota, req.params);
      const removido = await dispositivos.revogar(req.paciente.id, id);
      if (!removido) {
        throw new NaoEncontrado('Aparelho');
      }
      res.status(204).end();
    } catch (erro) {
      next(erro);
    }
  });

  return rotas;
}

module.exports = { criarRotasDeDispositivos };
