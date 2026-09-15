'use strict';

const { Router } = require('express');
const { z } = require('zod');

const {
  RepositorioDeProfissionaisPg,
} = require('../../../infra/db/RepositorioDeProfissionaisPg');
const { RepositorioDeHorariosPg } = require('../../../infra/db/RepositorioDeHorariosPg');
const { NaoEncontrado } = require('../../../domain/erros');
const { validar } = require('../validacao');
const { inteiroPositivo, data } = require('../esquemas');
const apresentar = require('../apresentadores');

const rotas = Router();
const profissionais = new RepositorioDeProfissionaisPg();
const horarios = new RepositorioDeHorariosPg();

const LIMITE_PADRAO = 20;
const JANELA_PADRAO_DIAS = 14;
const JANELA_MAXIMA_DIAS = 60;

const filtrosDaBusca = z.object({
  especialidade: inteiroPositivo('A especialidade').optional(),
  // `invalid_type_error` não é supérfluo: o Express transforma chaves
  // repetidas na query em array, então `?q=a&q=b` chega aqui como `['a','b']`
  // e o Zod recusaria com a mensagem padrão dele, em inglês.
  q: z
    .string({ invalid_type_error: 'Informe um único termo de busca.' })
    .trim()
    .min(2, 'Busque por ao menos duas letras.')
    .max(80, 'A busca é longa demais.')
    .optional(),
  pagina: inteiroPositivo('A página').default(1),
  limite: inteiroPositivo('O limite')
    .max(100, 'O limite máximo por página é 100.')
    .default(LIMITE_PADRAO),
});

const idNaRota = z.object({
  id: inteiroPositivo('O identificador'),
});

const janelaDeHorarios = z.object({
  de: data('A data inicial').optional(),
  ate: data('A data final').optional(),
});

/** GET /profissionais?especialidade=&q=&pagina=&limite= */
rotas.get('/', async (req, res, next) => {
  try {
    const filtros = validar(filtrosDaBusca, req.query);

    const { itens, total } = await profissionais.listar({
      especialidadeId: filtros.especialidade ?? null,
      termo: filtros.q ?? null,
      limite: filtros.limite,
      deslocamento: (filtros.pagina - 1) * filtros.limite,
    });

    res.json({
      profissionais: itens.map(apresentar.profissional),
      paginacao: {
        pagina: filtros.pagina,
        limite: filtros.limite,
        total,
        paginas: Math.max(1, Math.ceil(total / filtros.limite)),
      },
    });
  } catch (erro) {
    next(erro);
  }
});

/** GET /profissionais/:id */
rotas.get('/:id', async (req, res, next) => {
  try {
    const { id } = validar(idNaRota, req.params);

    const profissional = await profissionais.porId(id);
    if (!profissional || !profissional.atende()) {
      throw new NaoEncontrado('Profissional');
    }

    res.json({ profissional: apresentar.profissional(profissional) });
  } catch (erro) {
    next(erro);
  }
});

/**
 * GET /profissionais/:id/horarios?de=&ate=
 *
 * Devolve apenas horários disponíveis e futuros, cada um com sua `versao` —
 * ver o comentário em apresentadores.horario sobre por que esse campo é
 * indispensável.
 */
rotas.get('/:id/horarios', async (req, res, next) => {
  try {
    const { id } = validar(idNaRota, req.params);
    const janela = validar(janelaDeHorarios, req.query);

    const profissional = await profissionais.porId(id);
    if (!profissional || !profissional.atende()) {
      throw new NaoEncontrado('Profissional');
    }

    const agora = new Date();
    // Nunca oferecer horário no passado, mesmo que o cliente peça um `de`
    // anterior a agora: o agendamento recusaria depois, e melhor não exibir.
    const de = janela.de && janela.de > agora ? janela.de : agora;
    const ate =
      janela.ate ?? new Date(de.getTime() + JANELA_PADRAO_DIAS * 86_400_000);

    const limiteDaJanela = new Date(de.getTime() + JANELA_MAXIMA_DIAS * 86_400_000);
    const fim = ate > limiteDaJanela ? limiteDaJanela : ate;

    const disponiveis = await horarios.disponiveisDoProfissional(id, de, fim);

    res.json({
      periodo: { de: de.toISOString(), ate: fim.toISOString() },
      horarios: disponiveis.map(apresentar.horario),
    });
  } catch (erro) {
    next(erro);
  }
});

module.exports = rotas;
