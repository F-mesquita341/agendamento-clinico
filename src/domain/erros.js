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

/**
 * O paciente já tem consulta ativa que colide com o horário pedido.
 *
 * Classe própria, e não um `RegraDeNegocio` montado na hora, porque a mesma
 * recusa nasce em dois lugares: na verificação prévia do caso de uso e na
 * restrição de exclusão do banco, traduzida pelo adaptador. A mensagem que o
 * paciente lê precisa ser a mesma nos dois caminhos.
 */
class ConsultaSobreposta extends RegraDeNegocio {
  constructor() {
    super(
      'CONSULTA_SOBREPOSTA',
      'Você já tem uma consulta marcada nesse mesmo horário.'
    );
  }
}

/**
 * Token expirado é diferente de token inválido: a pessoa não fez nada de
 * errado, só o tempo passou. A ação diz ao app para renovar o token e repetir
 * a requisição em silêncio, em vez de mandar a pessoa de volta ao login.
 */
class SessaoExpirada extends ErroDeDominio {
  constructor() {
    super('SESSAO_EXPIRADA', 'Sua sessão expirou. Entre novamente para continuar.', {
      status: 401,
      acao: 'renovar_token',
    });
  }
}

/** Autenticado, mas ainda sem cadastro de paciente — o app leva ao cadastro. */
class PerfilNaoCadastrado extends ErroDeDominio {
  constructor() {
    super('PERFIL_NAO_CADASTRADO', 'Complete seu cadastro para continuar.', {
      status: 404,
      acao: 'completar_cadastro',
    });
  }
}

class PacienteJaCadastrado extends ErroDeDominio {
  constructor() {
    super('PACIENTE_JA_CADASTRADO', 'Esta conta já tem um cadastro de paciente.', {
      status: 409,
    });
  }
}

/**
 * LGPD, Art. 11: dado de saúde só pode ser tratado com consentimento
 * específico e destacado. A ação diz ao app para exibir o termo.
 */
class ConsentimentoObrigatorio extends ErroDeDominio {
  constructor(
    mensagem = 'Para se cadastrar, é preciso ler e aceitar o termo de consentimento.'
  ) {
    super('CONSENTIMENTO_OBRIGATORIO', mensagem, { status: 422, acao: 'exibir_termo' });
  }
}

module.exports = {
  ErroDeDominio,
  HorarioIndisponivel,
  NaoEncontrado,
  NaoAutenticado,
  AcessoNegado,
  RegraDeNegocio,
  ConsultaSobreposta,
  SessaoExpirada,
  PerfilNaoCadastrado,
  PacienteJaCadastrado,
  ConsentimentoObrigatorio,
};
