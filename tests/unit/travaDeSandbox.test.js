'use strict';

/**
 * A trava que impede a API de subir com credencial de conta real.
 *
 * Substituiu a recusa de pagamento com `live_mode` verdadeiro, que a primeira
 * ligação com o Mercado Pago real mostrou não distinguir nada: pagamento de
 * conta de teste também volta com modo real. Esta verificação pergunta de quem
 * é a credencial, e acontece antes de a porta abrir.
 */

const { verificarContaDeSandbox } = require('../../src/infra/pagamento/travaDeSandbox');
const { PagamentoIndisponivel } = require('../../src/domain/erros');

function gateway(resposta) {
  return {
    descreverConta: async () => {
      if (resposta instanceof Error) throw resposta;
      return resposta;
    },
  };
}

const CONTA_DE_TESTE = {
  id: '3699720609',
  apelido: 'TESTUSER3774910712453320476',
  siteId: 'MLB',
  ehContaDeTeste: true,
};

describe('verificarContaDeSandbox', () => {
  test('conta de teste libera a subida', async () => {
    const veredito = await verificarContaDeSandbox(gateway(CONTA_DE_TESTE));

    expect(veredito).toMatchObject({ liberado: true, motivo: null, mensagem: null });
    expect(veredito.conta).toEqual(CONTA_DE_TESTE);
  });

  test('conta real recusa a subida', async () => {
    const veredito = await verificarContaDeSandbox(
      gateway({ ...CONTA_DE_TESTE, id: '12345', apelido: 'FELIPE', ehContaDeTeste: false })
    );

    expect(veredito.liberado).toBe(false);
    expect(veredito.motivo).toBe('conta_real');
    // A mensagem tem de dizer QUAL conta, senão quem for consertar vai
    // adivinhar entre as credenciais que tem em mãos.
    expect(veredito.mensagem).toMatch(/12345/);
    expect(veredito.mensagem).toMatch(/FELIPE/);
  });

  test('provedor fora do ar também recusa: falha fechada', async () => {
    // "Não consegui verificar" não é "está tudo bem". Esta é a única coisa
    // entre o trabalho e o dinheiro de um participante de pesquisa.
    const veredito = await verificarContaDeSandbox(gateway(new PagamentoIndisponivel()));

    expect(veredito.liberado).toBe(false);
    expect(veredito.motivo).toBe('nao_verificada');
    expect(veredito.conta).toBeNull();
  });

  test('a recusa por indisponibilidade diz como trabalhar sem rede', async () => {
    const veredito = await verificarContaDeSandbox(gateway(new Error('fetch failed')));

    expect(veredito.mensagem).toMatch(/MERCADO_PAGO_ACCESS_TOKEN/);
  });
});
