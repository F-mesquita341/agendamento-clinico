'use strict';

/**
 * Rotas dos aparelhos que recebem notificação push.
 *
 *   POST   /dispositivos         registra o aparelho da conta autenticada
 *   DELETE /dispositivos/:token  revoga o aparelho
 *
 * Como em `/pacientes/me`, nenhuma rota recebe id de paciente: o dono é sempre
 * o do token verificado. E nenhuma resposta devolve o token do aparelho — ele
 * identifica o telefone, e o cliente já o tem.
 *
 * Revogar token que não é seu responde 404, e não 403. É a mesma postura das
 * consultas alheias: com 403, dava para descobrir se um token existe mandando
 * tentativas. Com 404, os dois casos — não existe e não é seu — são
 * indistinguíveis de fora.
 */

const { Router } = require('express');
const { z } = require('zod');

const { RepositorioDeDispositivosPg } = require('../../../infra/db/RepositorioDeDispositivosPg');
const { RepositorioDePacientesPg } = require('../../../infra/db/RepositorioDePacientesPg');
const { NaoEncontrado } = require('../../../domain/erros');
const { criarAutenticar } = require('../middlewares/autenticar');
const { criarCarregarPaciente } = require('../middlewares/carregarPaciente');
const { validar } = require('../validacao');
const { objetoEstrito } = require('../esquemas');

const PLATAFORMAS = ['android', 'ios', 'web'];

const corpoDoRegistro = objetoEstrito(
  {
    token: z
      .string({ required_error: 'Informe o token do aparelho.', invalid_type_error: 'O token precisa ser um texto.' })
      .trim()
      .min(1, 'Informe o token do aparelho.')
      // Tokens do Firebase passam de 150 caracteres; o limite é folgado de
      // propósito, só para impedir corpo absurdo.
      .max(4096, 'O token do aparelho é longo demais.'),
    plataforma: z.enum(PLATAFORMAS, {
      required_error: 'Informe a plataforma do aparelho.',
      invalid_type_error: `A plataforma precisa ser uma de: ${PLATAFORMAS.join(', ')}.`,
    }),
  },
  'O corpo do registro do aparelho'
);

function criarRotasDeDispositivos({
  verificarToken,
  pacientes = new RepositorioDePacientesPg(),
  dispositivos = new RepositorioDeDispositivosPg(),
}) {
  const rotas = Router();
  const autenticar = criarAutenticar(verificarToken);
  const carregarPaciente = criarCarregarPaciente(pacientes);

  rotas.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  rotas.post('/', autenticar, carregarPaciente, async (req, res, next) => {
    try {
      const { token, plataforma } = validar(corpoDoRegistro, req.body);
      await dispositivos.registrar({ pacienteId: req.paciente.id, token, plataforma });
      // Sem corpo: devolver o token só o repetiria de volta a quem o enviou,
      // e ele passaria a existir em mais um lugar (cache, log de cliente).
      res.status(201).json({ registrado: true });
    } catch (erro) {
      next(erro);
    }
  });

  rotas.delete('/:token', autenticar, carregarPaciente, async (req, res, next) => {
    try {
      const removido = await dispositivos.revogar(req.paciente.id, req.params.token);
      if (!removido) {
        throw new NaoEncontrado('Aparelho não encontrado.');
      }
      res.status(204).end();
    } catch (erro) {
      next(erro);
    }
  });

  return rotas;
}

module.exports = { criarRotasDeDispositivos };
