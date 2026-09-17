'use strict';

/**
 * Caso de uso: atualizar o próprio perfil.
 *
 * Só três campos são alteráveis. E-mail pertence à identidade no Firebase —
 * mudá-lo aqui dessincronizaria perfil e conta. Consentimento é um registro
 * histórico do que foi aceito, e não algo que se edita.
 *
 * A camada HTTP já recusa campos não permitidos; o filtro abaixo repete a
 * regra de propósito, para que ela valha mesmo se o caso de uso for chamado
 * por outro caminho no futuro.
 */

const { RegraDeNegocio } = require('../domain/erros');

const CAMPOS_ALTERAVEIS = Object.freeze(['nome', 'telefone', 'dataNascimento']);

class AtualizarPerfil {
  constructor({ pacientes }) {
    this.pacientes = pacientes;
  }

  async executar({ pacienteId, alteracoes = {} }) {
    const campos = Object.fromEntries(
      Object.entries(alteracoes).filter(
        ([campo, valor]) => CAMPOS_ALTERAVEIS.includes(campo) && valor !== undefined
      )
    );

    if (Object.keys(campos).length === 0) {
      throw new RegraDeNegocio(
        'NADA_A_ATUALIZAR',
        'Informe ao menos um campo para atualizar: nome, telefone ou data de nascimento.'
      );
    }

    // Sem leitura prévia do paciente: a rota já o resolveu pelo token, e o
    // repositório lança NaoEncontrado se o UPDATE não alcançar nenhuma linha.
    // Ler antes seria uma ida a mais ao banco em todo PATCH, sem proteger nada.
    return this.pacientes.atualizar(pacienteId, campos);
  }
}

module.exports = { AtualizarPerfil, CAMPOS_ALTERAVEIS };
