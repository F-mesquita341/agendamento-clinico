'use strict';

/**
 * Termo de consentimento vigente.
 *
 *   GET /consentimento/termo-vigente   → { termo: { versao } }
 *
 * O cadastro só aceita o aceite da versão vigente — ver
 * `Paciente.garantirConsentimento`. Se o aplicativo embutisse a versão, a
 * troca do termo, que ainda vai acontecer depois do parecer do Comitê de
 * Ética, quebraria o cadastro em todo aplicativo já instalado até sair uma
 * versão nova. Lendo daqui, ele sabe qual é a vigente.
 *
 * O ACEITE PRECISA SER DO TEXTO QUE A PESSOA LEU. A rota informa só a versão;
 * o texto vai no aplicativo. Se a vigente não for a do texto que o aplicativo
 * tem, ele não pode mostrar um texto e enviar o aceite de outro: pede para
 * atualizar o aplicativo.
 *
 * Pública, porque o termo é lido antes do cadastro, e sem cache, para que a
 * troca de versão valha já no pedido seguinte.
 */

const { Router } = require('express');

const { VERSAO_TERMO_CONSENTIMENTO } = require('../../../domain/Paciente');
const { semCache } = require('../middlewares/semCache');

const rotas = Router();

rotas.get('/termo-vigente', semCache, (req, res) => {
  res.json({ termo: { versao: VERSAO_TERMO_CONSENTIMENTO } });
});

module.exports = rotas;
