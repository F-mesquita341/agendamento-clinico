'use strict';

/**
 * Respostas com dado pessoal — perfil, consultas, aparelhos — não podem ficar
 * em cache de proxy nem do navegador. Consulta marcada é dado de saúde (LGPD,
 * Art. 11); um cache compartilhado a serviria a outra pessoa.
 *
 * Era a mesma função escrita à mão em cada roteador. Num lugar só, uma mudança
 * de política — acrescentar `private`, ou `Pragma` para proxies antigos — vale
 * para todos de uma vez.
 */

function semCache(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

module.exports = { semCache };
