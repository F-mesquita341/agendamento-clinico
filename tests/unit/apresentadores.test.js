'use strict';

const { Profissional } = require('../../src/domain/Profissional');
const apresentar = require('../../src/interfaces/http/apresentadores');

function profissionalCom(clinica) {
  return new Profissional({
    id: 1,
    clinicaId: 7,
    clinica,
    nome: 'José Antônio Ferreira',
    registroConselho: 'CRM-CE 12345',
    especialidade: { id: 2, nome: 'Cardiologia' },
    valorConsulta: 25000,
  });
}

describe('apresentador do profissional', () => {
  test('a clínica sai com lista fechada de campos, sem o CNPJ', () => {
    // O repositório hoje não seleciona o CNPJ, mas a lista fechada aqui é a
    // segunda barreira: se um JOIN futuro trouxer a linha inteira da clínica,
    // nada além destes quatro campos chega ao aplicativo.
    const json = apresentar.profissional(
      profissionalCom({
        id: 7,
        nome: 'Clínica Exemplo',
        telefone: '(88) 3000-0000',
        endereco: 'Centro, Quixadá - CE',
        cnpj: '00.000.000/0001-00',
      })
    );

    expect(json.clinica).toEqual({
      id: 7,
      nome: 'Clínica Exemplo',
      telefone: '(88) 3000-0000',
      endereco: 'Centro, Quixadá - CE',
    });
  });

  test('telefone e endereço ausentes saem como null, não somem do JSON', () => {
    // O aplicativo decide mostrar ou esconder "Ligar" pela presença do campo:
    // a chave precisa existir mesmo vazia.
    const json = apresentar.profissional(profissionalCom({ id: 7, nome: 'Clínica Exemplo' }));

    expect(json.clinica).toEqual({ id: 7, nome: 'Clínica Exemplo', telefone: null, endereco: null });
  });

  test('profissional montado sem clínica sai com clinica null', () => {
    const json = apresentar.profissional(profissionalCom(undefined));

    expect(json).toHaveProperty('clinica', null);
  });
});
