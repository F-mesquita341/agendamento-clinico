'use strict';

/**
 * Verificação da assinatura das notificações do Mercado Pago.
 *
 * Os valores esperados são literais, calculados uma vez fora deste arquivo:
 * recalculá-los aqui com a mesma fórmula faria o teste concordar consigo mesmo.
 * O que prova que a fórmula é a do Mercado Pago é outra coisa — uma notificação
 * real, simulada pelo painel deles contra a API publicada (Etapa 8, parte B).
 */

const { verificarAssinatura } = require('../../src/infra/pagamento/assinaturaMercadoPago');

const SEGREDO = 'segredo-de-teste';
const REQUISICAO = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
const TS = '1704908010';
const ASSINATURA_DE_123456 = '860ac38339722866664f7a6b3cd9ceff16bfca9c96d5b3ceec99c42264da3875';
const ASSINATURA_DE_ABC123DEF = 'f2565b575cb1c286db7693b00425142e3fe3d8ae2e2d4e6a4beee225faba86b5';

function notificacao(extra = {}) {
  return {
    cabecalhoAssinatura: `ts=${TS},v1=${ASSINATURA_DE_123456}`,
    idDaRequisicao: REQUISICAO,
    idDoDado: '123456',
    segredo: SEGREDO,
    ...extra,
  };
}

describe('verificarAssinatura', () => {
  test('assinatura correta é aceita', () => {
    expect(verificarAssinatura(notificacao())).toEqual({ valida: true, motivo: null });
  });

  test('espaços em volta das partes do cabeçalho não atrapalham', () => {
    expect(
      verificarAssinatura(notificacao({ cabecalhoAssinatura: ` ts=${TS} , v1=${ASSINATURA_DE_123456} ` })).valida
    ).toBe(true);
  });

  test('o id alfanumérico entra em minúsculas no manifesto', () => {
    // A assinatura foi calculada sobre "abc123def"; a notificação traz em
    // maiúsculas. Sem a conversão, uma notificação legítima seria recusada.
    expect(
      verificarAssinatura(
        notificacao({
          idDoDado: 'ABC123DEF',
          cabecalhoAssinatura: `ts=${TS},v1=${ASSINATURA_DE_ABC123DEF}`,
        })
      ).valida
    ).toBe(true);
  });

  test.each([
    ['id do pagamento trocado', { idDoDado: '654321' }],
    ['id da requisição trocado', { idDaRequisicao: 'outra-requisicao' }],
    ['instante trocado', { cabecalhoAssinatura: `ts=1704908011,v1=${ASSINATURA_DE_123456}` }],
    ['segredo errado', { segredo: 'outro-segredo' }],
    ['assinatura alterada num caractere', { cabecalhoAssinatura: `ts=${TS},v1=${ASSINATURA_DE_123456.replace(/.$/, '0')}` }],
  ])('%s é recusado', (_rotulo, estrago) => {
    expect(verificarAssinatura(notificacao(estrago))).toEqual({ valida: false, motivo: 'assinatura_nao_confere' });
  });

  test.each([
    ['sem cabeçalho', { cabecalhoAssinatura: undefined }, 'cabecalho_ausente'],
    ['cabeçalho vazio', { cabecalhoAssinatura: '' }, 'cabecalho_ausente'],
    ['sem ts', { cabecalhoAssinatura: `v1=${ASSINATURA_DE_123456}` }, 'cabecalho_malformado'],
    ['sem v1', { cabecalhoAssinatura: `ts=${TS}` }, 'cabecalho_malformado'],
    ['v1 que não é hexadecimal', { cabecalhoAssinatura: `ts=${TS},v1=zz` }, 'cabecalho_malformado'],
    ['sem o id do pagamento', { idDoDado: undefined }, 'dados_ausentes'],
    ['sem segredo configurado', { segredo: undefined }, 'sem_segredo'],
  ])('%s é recusado', (_rotulo, estrago, motivo) => {
    expect(verificarAssinatura(notificacao(estrago))).toEqual({ valida: false, motivo });
  });

  test('assinatura de tamanho diferente não derruba a comparação', () => {
    // timingSafeEqual lança com buffers de tamanhos diferentes; isso não pode
    // virar erro 500 — é só uma assinatura inválida.
    expect(
      verificarAssinatura(notificacao({ cabecalhoAssinatura: `ts=${TS},v1=abcd` })).valida
    ).toBe(false);
  });
});
