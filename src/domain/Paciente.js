'use strict';

/**
 * Paciente cadastrado na plataforma.
 *
 * A identidade (quem é a pessoa) pertence ao Firebase Authentication; esta
 * entidade guarda o perfil e, principalmente, a prova do consentimento. Todo
 * paciente existente consentiu — a migration 006 torna isso uma garantia do
 * próprio banco, e não apenas uma regra da aplicação.
 *
 * Minimização de dados (LGPD, Art. 6º, III): nada de CPF, endereço ou
 * documento. O escopo do trabalho — agendar, lembrar e simular o pagamento de
 * uma consulta — não precisa de nenhum deles.
 */

const { ConsentimentoObrigatorio } = require('./erros');

/**
 * Versão vigente do termo de consentimento.
 *
 * O texto correspondente está em docs/termo-de-consentimento.md. Ao alterar o
 * texto, esta constante muda junto: quem aceitou a versão anterior continua
 * registrado com ela, e é isso que permite provar a qual texto cada pessoa
 * consentiu.
 */
const VERSAO_TERMO_CONSENTIMENTO = '2026-09-v1';

class Paciente {
  constructor({
    id,
    firebaseUid,
    nome,
    email,
    telefone = null,
    dataNascimento = null,
    consentimentoVersao,
    consentimentoEm,
    criadoEm = null,
    atualizadoEm = null,
  }) {
    this.id = id;
    this.firebaseUid = firebaseUid;
    this.nome = nome;
    this.email = email;
    this.telefone = telefone;
    // Mantida como texto 'AAAA-MM-DD'. Convertê-la para Date introduziria fuso
    // horário numa informação que não tem hora — e um servidor em outro fuso
    // poderia exibir o dia anterior.
    this.dataNascimento = dataNascimento;
    this.consentimentoVersao = consentimentoVersao;
    this.consentimentoEm = consentimentoEm ? new Date(consentimentoEm) : null;
    this.criadoEm = criadoEm ? new Date(criadoEm) : null;
    this.atualizadoEm = atualizadoEm ? new Date(atualizadoEm) : null;
  }

  /**
   * Lança se o consentimento informado não autoriza o cadastro.
   *
   * Três situações recusadas: ausência de resposta, recusa explícita, e aceite
   * de uma versão que não é mais a vigente — caso em que a pessoa leu um texto
   * diferente do que valeria para ela.
   */
  static garantirConsentimento(consentimento) {
    if (!consentimento || consentimento.aceito !== true) {
      throw new ConsentimentoObrigatorio();
    }
    if (consentimento.versao !== VERSAO_TERMO_CONSENTIMENTO) {
      throw new ConsentimentoObrigatorio(
        'O termo de consentimento foi atualizado. Leia e aceite a versão atual para continuar.'
      );
    }
  }
}

module.exports = { Paciente, VERSAO_TERMO_CONSENTIMENTO };
