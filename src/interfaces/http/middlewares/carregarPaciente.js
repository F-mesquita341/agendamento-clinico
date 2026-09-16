'use strict';

/**
 * Resolve o paciente da identidade autenticada e o coloca em `req.paciente`.
 *
 * É este passo que impede um paciente de alcançar dado de outro: as rotas
 * de perfil nunca recebem um id de paciente pela URL ou pelo corpo. O único
 * paciente alcançável é o que corresponde ao `uid` do token verificado.
 *
 * Deve vir depois de `autenticar`.
 */

const { PerfilNaoCadastrado } = require('../../../domain/erros');

function criarCarregarPaciente(pacientes) {
  return async function carregarPaciente(req, res, next) {
    try {
      const paciente = await pacientes.porFirebaseUid(req.usuario.uid);
      if (!paciente) {
        throw new PerfilNaoCadastrado();
      }
      req.paciente = paciente;
      next();
    } catch (erro) {
      next(erro);
    }
  };
}

module.exports = { criarCarregarPaciente };
