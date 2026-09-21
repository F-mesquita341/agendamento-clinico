'use strict';

/**
 * O adaptador do Firebase Cloud Messaging, com um mensageiro falso.
 *
 * O assunto que mais importa aqui não é "enviou", é **quando um token pode ser
 * apagado**. Apagar por engano é silencioso: o paciente simplesmente deixa de
 * receber lembrete, para sempre, e nenhum erro aparece depois disso.
 */

const { ServicoFcm, ServicoNaoConfigurado } = require('../../src/infra/notificacao/ServicoFcm');

function mensageiro(resultados) {
  const chamadas = [];
  return {
    chamadas,
    async sendEachForMulticast(mensagem) {
      chamadas.push(mensagem);
      return {
        successCount: resultados.filter((r) => r === true).length,
        failureCount: resultados.filter((r) => r !== true).length,
        responses: resultados.map((r) =>
          r === true ? { success: true } : { success: false, error: { code: r } }
        ),
      };
    },
  };
}

const MENSAGEM = {
  titulo: 'Lembrete de consulta',
  corpo: 'Você tem uma consulta amanhã às 14:30.',
  dados: { consultaId: 42 },
};

describe('enviar', () => {
  test('manda uma mensagem só para todos os aparelhos', async () => {
    const falso = mensageiro([true, true]);
    const servico = new ServicoFcm({ messaging: falso });

    const resultado = await servico.enviar({ ...MENSAGEM, tokens: ['t1', 't2'] });

    expect(resultado).toEqual({ entregues: 2, invalidos: [] });
    expect(falso.chamadas).toHaveLength(1);
    expect(falso.chamadas[0]).toEqual({
      tokens: ['t1', 't2'],
      notification: { title: MENSAGEM.titulo, body: MENSAGEM.corpo },
      // O FCM só aceita texto em `data`.
      data: { consultaId: '42' },
    });
  });

  test('sem aparelho, nem chama o provedor', async () => {
    const falso = mensageiro([]);

    const resultado = await new ServicoFcm({ messaging: falso }).enviar({ ...MENSAGEM, tokens: [] });

    expect(resultado).toEqual({ entregues: 0, invalidos: [] });
    expect(falso.chamadas).toHaveLength(0);
  });

  test('o adaptador não acrescenta nada ao texto do domínio', async () => {
    const falso = mensageiro([true]);

    await new ServicoFcm({ messaging: falso }).enviar({ ...MENSAGEM, tokens: ['t1'] });

    const enviado = JSON.stringify(falso.chamadas[0]);
    expect(enviado).not.toMatch(/cardiolog|dermatolog|pediatr|ortoped|ginecolog|dr\.|doutor/i);
  });

  test.each([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
  ])('token recusado com %s é apagável', async (codigo) => {
    const falso = mensageiro([true, codigo]);

    const resultado = await new ServicoFcm({ messaging: falso }).enviar({
      ...MENSAGEM,
      tokens: ['bom', 'morto'],
    });

    expect(resultado).toEqual({ entregues: 1, invalidos: ['morto'] });
  });

  test.each([
    ['provedor instável', 'messaging/internal-error'],
    ['cota estourada', 'messaging/quota-exceeded'],
    ['serviço fora', 'messaging/server-unavailable'],
    ['erro sem código', undefined],
  ])('%s NÃO apaga o token', async (_rotulo, codigo) => {
    // Falha momentânea não é aparelho perdido. Apagar aqui deixaria o paciente
    // sem lembrete para sempre, em silêncio.
    const falso = mensageiro([codigo]);

    const resultado = await new ServicoFcm({ messaging: falso }).enviar({
      ...MENSAGEM,
      tokens: ['bom'],
    });

    expect(resultado.invalidos).toEqual([]);
  });

  test('o token apagado é o que falhou, não o da posição errada', async () => {
    // A resposta do FCM vem na mesma ordem dos tokens. Um deslocamento aqui
    // apagaria o aparelho certo de uma pessoa e manteria o morto.
    const falso = mensageiro([true, 'messaging/registration-token-not-registered', true]);

    const resultado = await new ServicoFcm({ messaging: falso }).enviar({
      ...MENSAGEM,
      tokens: ['primeiro', 'do-meio', 'ultimo'],
    });

    expect(resultado.invalidos).toEqual(['do-meio']);
  });
});

describe('ServicoNaoConfigurado', () => {
  test('não envia e não estoura — a API sobe sem credencial em desenvolvimento', async () => {
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const resultado = await new ServicoNaoConfigurado().enviar({ ...MENSAGEM, tokens: ['t1'] });

    expect(resultado).toEqual({ entregues: 0, invalidos: [] });
    expect(aviso).toHaveBeenCalled();
    aviso.mockRestore();
  });
});
