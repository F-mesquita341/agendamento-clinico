'use strict';

/**
 * Prova a credencial do Mercado Pago contra a API REAL, antes de ela ir para o
 * painel do Render.
 *
 * A suíte usa um `fetch` falso: ela prova o que o adaptador ENVIA, não que o
 * Mercado Pago aceita. Este script fecha essa lacuna sem depender de URL
 * pública nenhuma — criar uma preferência e buscar pagamentos são chamadas de
 * saída, que funcionam de qualquer máquina.
 *
 * É o passo 8 do plano da Etapa 8: descobrir aqui que a credencial está errada
 * custa um comando; descobrir no Render custa uma publicação que não sobe.
 *
 * Uso, no PowerShell, com MERCADO_PAGO_ACCESS_TOKEN já no .env:
 *
 *   npm run verificar:sandbox
 *
 * Ele imprime a URL do checkout. Abra no navegador, pague com a conta de teste
 * COMPRADORA e rode de novo com a referência que ele mostrou:
 *
 *   npm run verificar:sandbox -- --referencia <uuid>
 *
 * O token nunca é impresso.
 */

require('dotenv').config({ quiet: true });
const { randomUUID } = require('crypto');
const { GatewayMercadoPago } = require('../src/infra/pagamento/GatewayMercadoPago');
const { Dinheiro } = require('../src/domain/Dinheiro');
const { DESCRICAO_DO_ITEM } = require('../src/domain/Pagamento');

const TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const PRAZO_MS = 15_000;
const VALOR_CENTAVOS = 18050;

let falhas = 0;

function conferir(descricao, condicao, detalhe = '') {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}${!condicao && detalhe ? ` — ${detalhe}` : ''}`);
  if (!condicao) falhas += 1;
}

/**
 * Erro de parada prevista: mensagem já pronta para o terminal, sem pilha.
 *
 * `process.exit` seria mais direto, mas derruba o processo com uma conexão
 * ainda aberta, e no Windows isso vira uma asserção do libuv depois da
 * mensagem — feio e confundível com defeito. Lançar deixa o `fetch` terminar.
 */
class Parada extends Error {}

function abortar(mensagem) {
  throw new Parada(mensagem);
}

function referenciaDaLinhaDeComando() {
  const i = process.argv.indexOf('--referencia');
  return i >= 0 ? process.argv[i + 1] : null;
}

/**
 * Quem é o dono do token. Serve para confirmar, sem adivinhar, que a conta é a
 * de TESTE vendedora e não a conta real — a terceira trava de sandbox prevista
 * no plano, a que dependia de a API do Mercado Pago permitir distinguir as duas.
 */
async function quemSou() {
  let resposta;
  try {
    resposta = await fetch('https://api.mercadopago.com/users/me', {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(PRAZO_MS),
    });
  } catch (erro) {
    abortar(`O Mercado Pago não respondeu (${erro.name}). Confira a conexão e tente de novo.`);
  }

  // 401 é token malformado ou inexistente; 403, token que existe mas não vale
  // para esta conta ou está revogado. Para quem está configurando, é o mesmo
  // problema: a credencial no .env não serve.
  if (resposta.status === 401 || resposta.status === 403) {
    abortar(
      `O Mercado Pago recusou a credencial (HTTP ${resposta.status}).\n` +
        'Confira MERCADO_PAGO_ACCESS_TOKEN no .env: é o Access Token, não a\n' +
        'Public Key, e precisa ser o da conta de TESTE vendedora.'
    );
  }
  if (!resposta.ok) abortar(`O Mercado Pago respondeu HTTP ${resposta.status} em /users/me.`);

  return resposta.json();
}

async function criarCheckout(gateway) {
  console.log('\n2. Criar um checkout de verdade');
  const referencia = randomUUID();

  const checkout = await gateway.criarCheckout({
    referencia,
    descricao: DESCRICAO_DO_ITEM,
    valor: Dinheiro.deCentavos(VALOR_CENTAVOS),
    expiraEm: new Date(Date.now() + 15 * 60_000),
  });

  conferir('a preferência foi criada', Boolean(checkout.preferenciaId));
  conferir('veio endereço de pagamento', Boolean(checkout.checkoutUrl));
  console.log(`\n  referência .. ${referencia}`);
  console.log(`  preferência . ${checkout.preferenciaId}`);
  console.log(`  checkout .... ${checkout.checkoutUrl}`);

  console.log(
    '\n3. Agora, no navegador\n' +
      '  Abra o endereço acima numa janela anônima, entre com a conta de teste\n' +
      '  COMPRADORA e pague com um cartão de teste de aprovação. Depois rode:\n\n' +
      `    npm run verificar:sandbox -- --referencia ${referencia}\n`
  );
}

async function conferirPagamentos(gateway, referencia) {
  console.log(`\n2. Pagamentos da referência ${referencia}`);
  const pagamentos = await gateway.pagamentosDaReferencia(referencia);

  if (pagamentos.length === 0) {
    console.log(
      '  – nenhum pagamento ainda. Se você acabou de pagar, espere alguns\n' +
        '    segundos e rode de novo: o Mercado Pago leva um instante para indexar.'
    );
    falhas += 1;
    return;
  }

  for (const pagamento of pagamentos) {
    console.log(`\n  pagamento ... ${pagamento.id}`);
    console.log(`  status ...... ${pagamento.status}`);
    console.log(`  valor ....... ${pagamento.valorCentavos} centavos ${pagamento.moeda}`);
    console.log(`  modo real ... ${pagamento.modoReal}`);

    conferir('a referência voltou igual à enviada', pagamento.referencia === referencia);
    conferir('o valor voltou em centavos inteiros', Number.isInteger(pagamento.valorCentavos));
    conferir(
      'o valor é o que foi cobrado (R$ 180,50)',
      pagamento.valorCentavos === VALOR_CENTAVOS,
      `${pagamento.valorCentavos} centavos`
    );
    conferir('a moeda é BRL', pagamento.moeda === 'BRL');
    // `modoReal` NÃO é conferido aqui, e já foi: esta verificação existia e
    // falhava, porque conta de teste do Mercado Pago opera em modo produção e
    // devolve live_mode verdadeiro mesmo com dinheiro fictício. Quem garante o
    // sandbox é a conta, conferida no passo 1 e na subida da API.

    // A mesma consulta pelo id, que é o caminho que o webhook percorre.
    const porId = await gateway.consultarPagamento(pagamento.id);
    conferir('consultar pelo id devolve o mesmo pagamento', porId?.id === pagamento.id);
    conferir('e com o mesmo status', porId?.status === pagamento.status);
  }
}

async function principal() {
  if (!TOKEN) {
    abortar(
      'MERCADO_PAGO_ACCESS_TOKEN não está definida.\n' +
        'Coloque no .env o Access Token da conta de teste vendedora — só no .env,\n' +
        'que o git ignora.'
    );
  }

  console.log('\n1. De quem é a credencial');
  const eu = await quemSou();
  // Nada aqui é segredo: são dados da conta de teste, e o token não aparece.
  console.log(`  conta ....... ${eu.id} (${eu.nickname ?? 'sem apelido'})`);
  console.log(`  país ........ ${eu.site_id ?? '?'}`);
  console.log(`  marcas ...... ${(eu.tags ?? []).join(', ') || 'nenhuma'}`);

  // A marca `test_user` é posta pelo próprio Mercado Pago nas contas criadas
  // como conta de teste. É o MESMO sinal que a API confere na subida, em
  // infra/pagamento/travaDeSandbox.js — aqui ele aparece antes, para o
  // engano ser descoberto no terminal e não na publicação.
  const ehTeste = Array.isArray(eu.tags) && eu.tags.includes('test_user');
  if (ehTeste) {
    conferir('a credencial é de uma conta de teste', true);
  } else {
    console.log(
      '\n  PARE: esta credencial NÃO é de conta de teste.\n' +
        '  Um pagamento com ela seria dinheiro de verdade, de um participante de\n' +
        '  pesquisa. Troque pelo Access Token de uma conta de teste antes de\n' +
        '  qualquer outra coisa. (A API também se recusa a subir assim.)\n'
    );
    falhas += 1;
  }

  conferir('a conta opera no Brasil, como o BRL das preferências', eu.site_id === 'MLB', `site_id ${eu.site_id}`);

  const gateway = new GatewayMercadoPago({ accessToken: TOKEN, urlDeNotificacao: null });
  const referencia = referenciaDaLinhaDeComando();

  if (referencia) {
    await conferirPagamentos(gateway, referencia);
    console.log(
      falhas
        ? `\n${falhas} verificação(ões) falharam.\n`
        : '\nCredencial de conta de teste, e adaptador conversando com o Mercado Pago\n' +
            'de verdade: a preferência é criada e o pagamento volta traduzido para o\n' +
            'domínio, com valor e moeda conferidos. O token pode ir para o Render.\n'
    );
  } else {
    await criarCheckout(gateway);
  }

  process.exitCode = falhas ? 1 : 0;
}

principal().catch((erro) => {
  console.error(erro instanceof Parada ? `\n${erro.message}\n` : `\nFalha inesperada: ${erro.message}\n`);
  process.exitCode = 1;
});
