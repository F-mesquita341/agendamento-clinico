'use strict';

/**
 * Adaptador PostgreSQL para pacientes.
 *
 * Toda escrita acontece dentro de `transacao()` junto com a linha de auditoria:
 * ou as duas ficam, ou nenhuma. Um cadastro sem registro de auditoria seria
 * exatamente o tipo de tratamento de dado sensível sem rastro que Fachin e
 * Domingues (2022) apontam como risco.
 */

const { RepositorioDePacientes } = require('../../domain/repositorios');
const { Paciente } = require('../../domain/Paciente');
const { NaoEncontrado, PacienteJaCadastrado } = require('../../domain/erros');
const { consultar, transacao } = require('./pool');

// data_nascimento sai como texto 'AAAA-MM-DD'. O driver converteria DATE em
// Date à meia-noite do fuso do servidor, e em fuso positivo isso vira o dia
// anterior ao ser serializado — ver o comentário em domain/Paciente.js.
const COLUNAS = `
  id, firebase_uid, nome, email, telefone,
  data_nascimento::text AS data_nascimento,
  consentimento_versao, consentimento_em, criado_em, atualizado_em
`;

/** Campo do domínio → coluna do banco. Só estes podem ser atualizados. */
const COLUNA_DO_CAMPO = Object.freeze({
  nome: 'nome',
  telefone: 'telefone',
  dataNascimento: 'data_nascimento',
});

function paraEntidade(linha) {
  return new Paciente({
    id: Number(linha.id),
    firebaseUid: linha.firebase_uid,
    nome: linha.nome,
    email: linha.email,
    telefone: linha.telefone,
    dataNascimento: linha.data_nascimento,
    consentimentoVersao: linha.consentimento_versao,
    consentimentoEm: linha.consentimento_em,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
  });
}

async function auditar(cliente, { pacienteId, acao, detalhe }) {
  await cliente.query(
    `INSERT INTO auditoria (ator_tipo, ator_id, acao, entidade, entidade_id, detalhe)
     VALUES ('paciente', $1, $2, 'paciente', $1, $3)`,
    [pacienteId, acao, detalhe]
  );
}

class RepositorioDePacientesPg extends RepositorioDePacientes {
  async porFirebaseUid(firebaseUid) {
    const { rows } = await consultar(
      `SELECT ${COLUNAS} FROM paciente WHERE firebase_uid = $1`,
      [firebaseUid]
    );
    return rows.length ? paraEntidade(rows[0]) : null;
  }

  async porId(id) {
    const { rows } = await consultar(`SELECT ${COLUNAS} FROM paciente WHERE id = $1`, [id]);
    return rows.length ? paraEntidade(rows[0]) : null;
  }

  async criar(dados) {
    return transacao(async (cliente) => {
      let linha;
      try {
        const { rows } = await cliente.query(
          `INSERT INTO paciente
             (firebase_uid, nome, email, telefone, data_nascimento,
              consentimento_versao, consentimento_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${COLUNAS}`,
          [
            dados.firebaseUid,
            dados.nome,
            dados.email,
            dados.telefone ?? null,
            dados.dataNascimento ?? null,
            dados.consentimentoVersao,
            dados.consentimentoEm,
          ]
        );
        linha = rows[0];
      } catch (erro) {
        // Só esta restrição vira 409. Qualquer outra violação é defeito, e
        // defeito precisa aparecer como 500, não se disfarçar de conflito.
        if (erro.code === '23505' && erro.constraint === 'paciente_firebase_uid_key') {
          throw new PacienteJaCadastrado();
        }
        throw erro;
      }

      await auditar(cliente, {
        pacienteId: linha.id,
        acao: 'paciente.cadastrado',
        // A versão do termo não é dado pessoal, e é justamente o que importa
        // provar depois.
        detalhe: { consentimentoVersao: dados.consentimentoVersao },
      });

      return paraEntidade(linha);
    });
  }

  async atualizar(id, campos) {
    const entradas = Object.entries(campos).filter(([campo]) => COLUNA_DO_CAMPO[campo]);

    // Sem campo válido, não há UPDATE a fazer — e montá-lo produziria
    // "SET , atualizado_em", erro de sintaxe. O caso de uso já barra esse caso;
    // o adaptador não depende disso.
    if (entradas.length === 0) {
      const atual = await this.porId(id);
      if (!atual) throw new NaoEncontrado('Paciente');
      return atual;
    }

    return transacao(async (cliente) => {
      // Nomes de coluna vêm do mapa fixo acima, nunca da entrada; os valores
      // seguem parametrizados.
      const atribuicoes = entradas.map(([campo], i) => `${COLUNA_DO_CAMPO[campo]} = $${i + 2}`);
      const { rows } = await cliente.query(
        `UPDATE paciente
            SET ${atribuicoes.join(', ')}, atualizado_em = now()
          WHERE id = $1
          RETURNING ${COLUNAS}`,
        [id, ...entradas.map(([, valor]) => valor)]
      );

      // O paciente pode ter sido removido entre a leitura do caso de uso e esta
      // escrita. Sem esta checagem, a resposta seria um 500 por acesso a
      // `undefined`, e a auditoria registraria uma alteração que não aconteceu.
      if (rows.length === 0) {
        throw new NaoEncontrado('Paciente');
      }

      await auditar(cliente, {
        pacienteId: id,
        acao: 'paciente.atualizado',
        detalhe: { campos: entradas.map(([campo]) => campo) },
      });

      return paraEntidade(rows[0]);
    });
  }
}

module.exports = { RepositorioDePacientesPg };
