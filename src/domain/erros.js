'use strict';

/**
 * Erros do domínio.
 *
 * Esta camada não conhece HTTP. Cada erro carrega um código estável, uma
 * mensagem escrita para o usuário final e, quando existe, a AÇÃO que o
 * aplicativo deve tomar. É esse campo `acao` que torna explícito o fallback
 * exigido na Seção 3.8.3 do projeto: o app não precisa interpretar texto
 * para saber o que fazer depois de uma colisão.
 *
 * A tradução de erro para status HTTP acontece em interfaces/http.
 */

class ErroDeDominio extends Error {
  constructor(codigo, mensagem, { status = 422, acao = null } = {}) {
    super(mensagem);
    this.name = this.constructor.name;
    this.codigo = codigo;
    this.status = status;
    this.acao = acao;
    this.esperado = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** Duas pessoas tentaram o mesmo horário. Caminho esperado, não falha do sistema. */
class HorarioIndisponivel extends ErroDeDominio {
  constructor() {
    super(
      'HORARIO_INDISPONIVEL',
      'Este horário acabou de ser reservado por outro paciente.',
      { status: 409, acao: 'recarregar_horarios' }
    );
  }
}

class NaoEncontrado extends ErroDeDominio {
  constructor(oQue = 'Recurso') {
    super('NAO_ENCONTRADO', `${oQue} não encontrado.`, { status: 404 });
  }
}

class NaoAutenticado extends ErroDeDominio {
  constructor(mensagem = 'Faça login para continuar.') {
    super('NAO_AUTENTICADO', mensagem, { status: 401, acao: 'autenticar' });
  }
}

class AcessoNegado extends ErroDeDominio {
  constructor(mensagem = 'Este recurso pertence a outro paciente.') {
    super('ACESSO_NEGADO', mensagem, { status: 403 });
  }
}

class RegraDeNegocio extends ErroDeDominio {
  constructor(codigo, mensagem) {
    super(codigo, mensagem, { status: 422 });
  }
}

module.exports = {
  ErroDeDominio,
  HorarioIndisponivel,
  NaoEncontrado,
  NaoAutenticado,
  AcessoNegado,
  RegraDeNegocio,
};
