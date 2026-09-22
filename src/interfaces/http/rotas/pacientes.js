'use strict';

/**
 * Rotas do perfil do paciente.
 *
 *   POST  /pacientes     cadastra o perfil da conta autenticada
 *   GET   /pacientes/me  lê o próprio perfil
 *   PATCH /pacientes/me  atualiza nome, telefone ou data de nascimento
 *
 * Não existe rota que receba id de paciente. `/me` é resolvido a partir do
 * token verificado, e é isso que torna impossível ler o perfil de outra pessoa
 * trocando um número na URL.
 *
 * Fábrica, e não Router montado na importação, porque o verificador de token
 * precisa ser injetado — o real em produção, um falso nos testes.
 */

const { Router } = require('express');
const { z } = require('zod');

const { CadastrarPaciente } = require('../../../application/CadastrarPaciente');
const { AtualizarPerfil } = require('../../../application/AtualizarPerfil');
const { RepositorioDePacientesPg } = require('../../../infra/db/RepositorioDePacientesPg');
const { criarAutenticar } = require('../middlewares/autenticar');
const { criarCarregarPaciente } = require('../middlewares/carregarPaciente');
const { semCache } = require('../middlewares/semCache');
const { validar } = require('../validacao');
const {
  objetoEstrito,
  nomeDePessoa,
  telefone,
  dataDeNascimento,
} = require('../esquemas');
const apresentar = require('../apresentadores');

const corpoDoCadastro = objetoEstrito(
  {
    nome: nomeDePessoa(),
    telefone: telefone().nullable().optional(),
    dataNascimento: dataDeNascimento().nullable().optional(),
    // Opcional no formato: a ausência é recusada pelo domínio, com o código
    // CONSENTIMENTO_OBRIGATORIO e a ação de exibir o termo — mais útil ao
    // aplicativo do que um erro genérico de campo faltando.
    consentimento: z
      .object(
        {
          aceito: z
            .boolean({ invalid_type_error: 'O aceite do termo precisa ser verdadeiro ou falso.' })
            .optional(),
          versao: z
            .string({ invalid_type_error: 'A versão do termo precisa ser um texto.' })
            .optional(),
        },
        { invalid_type_error: 'O consentimento precisa ser um objeto.' }
      )
      .optional(),
  },
  'O corpo do cadastro'
);

const corpoDaAtualizacao = objetoEstrito(
  {
    nome: nomeDePessoa().optional(),
    telefone: telefone().nullable().optional(),
    dataNascimento: dataDeNascimento().nullable().optional(),
  },
  'O corpo da atualização'
);

function criarRotasDePacientes({
  verificarToken,
  pacientes = new RepositorioDePacientesPg(),
  relogio,
}) {
  const rotas = Router();
  const autenticar = criarAutenticar(verificarToken);
  const carregarPaciente = criarCarregarPaciente(pacientes);
  const cadastrar = new CadastrarPaciente({ pacientes, ...(relogio ? { relogio } : {}) });
  const atualizar = new AtualizarPerfil({ pacientes });

  rotas.use(semCache);

  rotas.post('/', autenticar, async (req, res, next) => {
    try {
      const corpo = validar(corpoDoCadastro, req.body);
      const paciente = await cadastrar.executar({ identidade: req.usuario, ...corpo });
      res.status(201).location('/pacientes/me').json({ paciente: apresentar.paciente(paciente) });
    } catch (erro) {
      next(erro);
    }
  });

  rotas.get('/me', autenticar, carregarPaciente, (req, res) => {
    res.json({ paciente: apresentar.paciente(req.paciente) });
  });

  rotas.patch('/me', autenticar, carregarPaciente, async (req, res, next) => {
    try {
      const alteracoes = validar(corpoDaAtualizacao, req.body);
      const paciente = await atualizar.executar({ pacienteId: req.paciente.id, alteracoes });
      res.json({ paciente: apresentar.paciente(paciente) });
    } catch (erro) {
      next(erro);
    }
  });

  return rotas;
}

module.exports = { criarRotasDePacientes };
