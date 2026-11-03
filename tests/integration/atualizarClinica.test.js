'use strict';

/**
 * O roteiro que põe os dados reais da clínica parceira no lugar dos fictícios.
 * Contra o PostgreSQL real: a garantia de não escrever por cima de uma mudança
 * feita no meio da confirmação mora no WHERE do UPDATE.
 */

const { consultar } = require('../../src/infra/db/pool');
const { semear } = require('../helpers/semente');
const { atualizarClinica, lerArgumentos, Recusa } = require('../../scripts/atualizar-clinica');

let dados;

beforeEach(async () => {
  dados = await semear();
});

async function clinica(id = dados.clinicaId) {
  const { rows } = await consultar('SELECT nome, telefone, endereco FROM clinica WHERE id = $1', [id]);
  return rows[0];
}

const REAIS = {
  nome: 'Clínica Parceira',
  telefone: '(88) 3412-0000',
  endereco: 'Rua Exemplo, 10 - Centro, Quixadá - CE',
};

describe('atualizarClinica', () => {
  test('mostra o antes e o depois e só grava com a confirmação', async () => {
    let mostrado;
    const r = await atualizarClinica({
      novos: REAIS,
      confirmar: async (mudanca) => {
        mostrado = mudanca;
        return true;
      },
    });

    expect(mostrado).toEqual({
      id: dados.clinicaId,
      atual: { nome: 'Clínica de Teste', telefone: null, endereco: null },
      depois: REAIS,
    });
    expect(r.escrito).toBe(true);
    expect(await clinica()).toEqual(REAIS);
  });

  test('sem confirmação, nada muda', async () => {
    const r = await atualizarClinica({ novos: REAIS, confirmar: async () => false });

    expect(r.escrito).toBe(false);
    expect(await clinica()).toEqual({ nome: 'Clínica de Teste', telefone: null, endereco: null });
  });

  test('só os campos informados mudam', async () => {
    await atualizarClinica({ novos: { telefone: '(88) 3412-0000' }, confirmar: async () => true });

    expect(await clinica()).toEqual({
      nome: 'Clínica de Teste',
      telefone: '(88) 3412-0000',
      endereco: null,
    });
  });

  test('o que já está igual nem pergunta', async () => {
    const confirmar = jest.fn(async () => true);

    const r = await atualizarClinica({ novos: { nome: 'Clínica de Teste' }, confirmar });

    expect(confirmar).not.toHaveBeenCalled();
    expect(r.escrito).toBe(false);
  });

  test('mudança feita durante a confirmação não é sobrescrita', async () => {
    await expect(
      atualizarClinica({
        novos: REAIS,
        confirmar: async () => {
          // Outra pessoa grava enquanto a pergunta espera.
          await consultar(`UPDATE clinica SET telefone = '(88) 9999-0000' WHERE id = $1`, [
            dados.clinicaId,
          ]);
          return true;
        },
      })
    ).rejects.toThrow(/mudou enquanto você confirmava/);

    expect(await clinica()).toEqual({
      nome: 'Clínica de Teste',
      telefone: '(88) 9999-0000',
      endereco: null,
    });
  });

  test('com mais de uma clínica, exige --id e muda só a escolhida', async () => {
    const { rows } = await consultar(
      `INSERT INTO clinica (nome, cnpj) VALUES ('Outra Clínica', '22.222.222/0001-22') RETURNING id`
    );
    const outra = Number(rows[0].id);

    await expect(
      atualizarClinica({ novos: REAIS, confirmar: async () => true })
    ).rejects.toThrow(/diga qual com --id/);

    await atualizarClinica({ id: outra, novos: REAIS, confirmar: async () => true });

    expect(await clinica(outra)).toEqual(REAIS);
    expect((await clinica()).nome).toBe('Clínica de Teste');
  });

  test('id que não existe é recusado', async () => {
    await expect(
      atualizarClinica({ id: 999999, novos: REAIS, confirmar: async () => true })
    ).rejects.toBeInstanceOf(Recusa);
  });
});

describe('lerArgumentos', () => {
  test('lê os campos e o id', () => {
    expect(lerArgumentos(['--id', '3', '--nome', ' Clínica X ', '--telefone', '(88) 1'])).toEqual({
      id: 3,
      novos: { nome: 'Clínica X', telefone: '(88) 1' },
    });
  });

  test.each([
    [[], /ao menos um campo/],
    [['--cnpj', '1'], /desconhecido/],
    [['--nome'], /precisa de um valor/],
    [['--nome', '   '], /precisa de um valor/],
    [['--nome', '--telefone', 'x'], /precisa de um valor/],
    [['--id', 'abc', '--nome', 'X'], /inteiro positivo/],
    [['--id', '2'], /ao menos um campo/],
  ])('recusa %j', (args, mensagem) => {
    expect(() => lerArgumentos(args)).toThrow(mensagem);
  });
});
