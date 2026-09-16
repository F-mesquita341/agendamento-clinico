'use strict';

/**
 * Exige `Authorization: Bearer <token>` e preenche `req.usuario` com a
 * identidade verificada — `{ uid, email }`.
 *
 * A identidade de quem faz a requisição passa a existir só a partir daqui, e
 * só daqui. Nenhuma rota deve ler uid ou e-mail do corpo da requisição.
 *
 * O verificador é injetado: em produção, o do Firebase; nos testes, um falso
 * com o mesmo contrato (ver src/infra/firebase/verificadorDeToken.js).
 */

const { NaoAutenticado } = require('../../../domain/erros');

function criarAutenticar(verificarToken) {
  return async function autenticar(req, res, next) {
    try {
      const partes = (req.get('authorization') ?? '').trim().split(/\s+/);
      const [esquema, token] = partes;

      if (partes.length !== 2 || !/^bearer$/i.test(esquema) || !token) {
        throw new NaoAutenticado();
      }

      req.usuario = await verificarToken(token);
      next();
    } catch (erro) {
      next(erro);
    }
  };
}

module.exports = { criarAutenticar };
