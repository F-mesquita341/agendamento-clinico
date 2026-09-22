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
  ])('token recusado com %s é apagável', async (codigo) => {
    const falso = mensageiro([true, codigo]);

    const resultado = await new ServicoFcm({ messaging: falso }).enviar({
      ...MENSAGEM,
      tokens: ['bom', 'morto'],
    });

    expect(resultado).toEqual({ entregues: 1, invalidos: ['morto'] });
  });

  test('invalid-argument NÃO apaga o token, e isso é deliberado', async () => {
    // Ele quase sempre é token malformado — mas é também o que o FCM devolve
    // quando a MENSAGEM é inválida. A mensagem é a mesma para todos os
    // aparelhos: um defeito nosso no payload faria todos falharem assim, e
    // apagaríamos de uma vez todos os aparelhos do paciente. Um erro nosso
    // viraria perda de dado de quem não tem nada com isso.
    const falso = mensageiro(['messaging/invalid-argument', 'messaging/invalid-argument']);

    const resultado = await new ServicoFcm({ messaging: falso }).enviar({
      ...MENSAGEM,
      tokens: ['aparelho-1', 'aparelho-2'],
    });

    expect(resultado.invalidos).toEqual([]);
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

describe('prazo de validade', () => {
  const AGORA = new Date('2026-09-21T13:00:00Z');
  const relogio = { agora: () => AGORA };

  test('a mensagem expira no instante informado, nas três plataformas', async () => {
    // Sem prazo, o FCM guarda a mensagem por até quatro semanas para aparelho
    // desligado, e o lembrete de uma consulta poderia chegar depois dela.
    const falso = mensageiro([true]);
    const expiraEm = new Date(AGORA.getTime() + 20 * 60 * 60 * 1000); // daqui a 20 h

    await new ServicoFcm({ messaging: falso, relogio }).enviar({ ...MENSAGEM, tokens: ['t1'], expiraEm });

    const enviado = falso.chamadas[0];
    expect(enviado.android).toEqual({ ttl: 20 * 60 * 60 * 1000 });
    expect(enviado.webpush).toEqual({ headers: { TTL: String(20 * 60 * 60) } });
    expect(enviado.apns).toEqual({
      headers: { 'apns-expiration': String(Math.floor(expiraEm.getTime() / 1000)) },
    });
  });

  test('prazo já vencido vira validade zero, não negativa', async () => {
    const falso = mensageiro([true]);

    await new ServicoFcm({ messaging: falso, relogio }).enviar({
      ...MENSAGEM,
      tokens: ['t1'],
      expiraEm: new Date(AGORA.getTime() - 1000),
    });

    expect(falso.chamadas[0].android.ttl).toBe(0);
  });
});

describe('lotes de 500', () => {
  test('mais de 500 aparelhos vão em mais de uma chamada, e os resultados se somam', async () => {
    // O FCM estoura acima de 500 destinos. Sem os lotes, um paciente com mais
    // aparelhos que isso travaria o lembrete num ciclo sem fim.
    const tokens = Array.from({ length: 501 }, (_, i) => `t${i}`);
    const chamadas = [];
    const falso = {
      async sendEachForMulticast(mensagem) {
        chamadas.push(mensagem.tokens);
        const ultimoMorto = mensagem.tokens.includes('t500');
        return {
          successCount: mensagem.tokens.length - (ultimoMorto ? 1 : 0),
          responses: mensagem.tokens.map((t) =>
            t === 't500'
              ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
              : { success: true }
          ),
        };
      },
    };

    const resultado = await new ServicoFcm({ messaging: falso }).enviar({ ...MENSAGEM, tokens });

    expect(chamadas.map((c) => c.length)).toEqual([500, 1]);
    expect(resultado).toEqual({ entregues: 500, invalidos: ['t500'] });
  });
});

describe('ServicoNaoConfigurado', () => {
  test('ESTOURA, em vez de responder "zero entregues"', async () => {
    // Responder zero parecia inofensivo: a rotina entenderia "ninguém
    // recebeu", manteria a marca, e aquela consulta nunca mais seria lembrada.
    // Estourando, a rotina desfaz a marca e a consulta volta à fila.
    await expect(
      new ServicoNaoConfigurado().enviar({ ...MENSAGEM, tokens: ['t1'] })
    ).rejects.toThrow(/não configurado/);
  });
});
