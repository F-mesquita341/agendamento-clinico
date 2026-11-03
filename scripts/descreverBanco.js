'use strict';

/**
 * Host e nome do banco, sem usuário nem senha — para um script dizer em que
 * banco vai mexer antes de mexer. Endereço ilegível não volta inteiro: a
 * string de conexão carrega a senha, e ela não pode parar num terminal.
 */
function descreverBanco(url) {
  try {
    const endereco = new URL(url);
    return `${endereco.hostname}${endereco.pathname}`;
  } catch {
    return '(endereço do banco ilegível)';
  }
}

module.exports = { descreverBanco };
