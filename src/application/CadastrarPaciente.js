'use strict';

/**
 * Caso de uso: cadastrar o perfil de paciente de uma conta autenticada.
 *
 * A `identidade` chega do verificador de token — é a única fonte de uid e
 * e-mail. Qualquer e-mail ou uid presente no corpo da requisição é ignorado,
 * o que impede alguém de criar um perfil em nome de outra pessoa.
 *
 * O consentimento é pré-condição, e o instante do aceite é o do servidor: um
 * horário enviado pelo aplicativo não prova nada, porque o aplicativo pode
 * mandar qualquer horário.
 */

const { Paciente } = require('../domain/Paciente');
const {
  NaoAutenticado,
  PacienteJaCadastrado,
  RegraDeNegocio,
} = require('../domain/erros');
const { relogioDoSistema } = require('../domain/Relogio');

class CadastrarPaciente {
  constructor({ pacientes, relogio = relogioDoSistema }) {
    this.pacientes = pacientes;
    this.relogio = relogio;
  }

  async executar({ identidade, nome, telefone = null, dataNascimento = null, consentimento }) {
    if (!identidade?.uid) {
      throw new NaoAutenticado();
    }
    if (!identidade.email) {
      throw new RegraDeNegocio(
        'CONTA_SEM_EMAIL',
        'Sua conta precisa ter um e-mail para concluir o cadastro.'
      );
    }

    // Antes de qualquer leitura ou escrita: sem consentimento, não se toca em
    // dado pessoal nenhum.
    Paciente.garantirConsentimento(consentimento);

    // Checagem para a mensagem boa no caso comum. Não garante exclusividade —
    // duas requisições simultâneas passam por aqui juntas; quem decide é a
    // restrição UNIQUE do banco, traduzida pelo adaptador no mesmo erro.
    if (await this.pacientes.porFirebaseUid(identidade.uid)) {
      throw new PacienteJaCadastrado();
    }

    return this.pacientes.criar({
      firebaseUid: identidade.uid,
      email: identidade.email,
      nome,
      telefone,
      dataNascimento,
      consentimentoVersao: consentimento.versao,
      consentimentoEm: this.relogio.agora(),
    });
  }
}

module.exports = { CadastrarPaciente };
