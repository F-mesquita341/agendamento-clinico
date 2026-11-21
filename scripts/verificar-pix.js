'use strict';

/**
 * Pix contra o Mercado Pago REAL em sandbox. Nasceu como a P0 (21/11), a prova
 * de viabilidade antes do código; agora cria o Pix pelo adaptador da API
 * (`GatewayMercadoPago.criarPix`), para provar o corpo que ela de fato envia.
 *
 * Responde a duas perguntas que decidem o desenho:
 *   (a) a credencial de teste atual aceita a API de Orders (Checkout
 *       Transparente)? Se não aceitar, o Pix para aqui.
 *   (b) o pagamento do pedido aparece na busca de pagamentos por referência
 *       (`/v1/payments/search?external_reference=`), que a reconciliação da
 *       expiração já usa? Se aparecer, a reconciliação não precisa mudar.
 *
 * O pagador é fictício e fixo: `first_name: "APRO"`, que, no ambiente de teste,
 * faz o pedido se aprovar sozinho. Nenhum dado de paciente sai daqui. Antes de
 * criar qualquer coisa, a trava de sandbox confere que a credencial é de uma
 * conta de TESTE. O token nunca é impresso.
 *
 *   npm run verificar:pix
 */

require('dotenv').config({ quiet: true });

const { randomUUID } = require('node:crypto');
const { GatewayMercadoPago } = require('../src/infra/pagamento/GatewayMercadoPago');
const { verificarContaDeSandbox } = require('../src/infra/pagamento/travaDeSandbox');
const { Dinheiro } = require('../src/domain/Dinheiro');

const TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const BASE = 'https://api.mercadopago.com';
const PRAZO_MS = 15_000;
const ESPERA_MAXIMA_MS = 120_000;
const INTERVALO_MS = 5_000;

let falhas = 0;
function conferir(descricao, condicao, detalhe = '') {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}${!condicao && detalhe ? ` — ${detalhe}` : ''}`);
  if (!condicao) falhas += 1;
}

class Parada extends Error {}

/** O corpo de um erro do Mercado Pago, sem nada que identifique a conta. */
function resumoDoErro(json) {
  if (!json || typeof json !== 'object') return '';
  const partes = [json.error, json.message, json.code];
  if (Array.isArray(json.errors)) {
    for (const e of json.errors.slice(0, 3)) partes.push(e.code, e.message, (e.details || []).join('; '));
  }
  return partes.filter(Boolean).join(' | ').slice(0, 400);
}

/** Só leitura: a criação passa pelo adaptador. */
async function chamar(metodo, caminho) {
  let resposta;
  try {
    resposta = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(PRAZO_MS),
    });
  } catch (erro) {
    throw new Parada(`O Mercado Pago não respondeu a ${metodo} ${caminho.split('?')[0]} (${erro.name}).`);
  }
  let json = null;
  try {
    json = await resposta.json();
  } catch {
    json = null;
  }
  return { status: resposta.status, json };
}

function pagamentoDoPedido(pedido) {
  return pedido?.transactions?.payments?.[0] ?? null;
}

async function principal() {
  if (!TOKEN) throw new Parada('MERCADO_PAGO_ACCESS_TOKEN não está no .env.');

  console.log('\n1. A credencial é de conta de teste?');
  const gateway = new GatewayMercadoPago({ accessToken: TOKEN });
  const veredito = await verificarContaDeSandbox(gateway);
  conferir('a trava de sandbox liberou', veredito.liberado, veredito.motivo || '');
  if (!veredito.liberado) throw new Parada('A credencial não passou na trava de sandbox. Nada foi criado.');

  // Pelo adaptador de verdade (o mesmo corpo que a API envia, com o prazo), e
  // não por um corpo montado aqui: assim o sandbox prova o código em uso.
  console.log('\n2. Criar um Pix de teste pela API (R$ 1,00, pagador fictício APRO, prazo de 15 min)');
  const referencia = randomUUID();
  let criado;
  try {
    criado = await gateway.criarPix({
      referencia,
      valor: Dinheiro.deCentavos(100),
      expiraEm: new Date(Date.now() + 15 * 60_000),
    });
  } catch (erro) {
    conferir('(a) a API de Orders aceitou o pedido', false, erro.message);
    throw new Parada('A credencial não aceitou criar um pedido Pix: o Pix não é viável assim.');
  }
  conferir('(a) a API de Orders aceitou o pedido, com o código e a imagem', true);

  const lidoNaCriacao = await chamar('GET', `/v1/orders/${encodeURIComponent(criado.pedidoId)}`);
  if (lidoNaCriacao.status !== 200) {
    throw new Parada(`GET /v1/orders/{id} respondeu HTTP ${lidoNaCriacao.status}: ${resumoDoErro(lidoNaCriacao.json)}`);
  }
  const pedido = lidoNaCriacao.json;
  conferir('o "copia e cola" devolvido pela API é o do pedido',
    pagamentoDoPedido(pedido)?.payment_method?.qr_code === criado.copiaECola);
  const pagamento = pagamentoDoPedido(pedido);
  const metodo = pagamento?.payment_method ?? {};
  console.log(`  pedido ...... ${pedido.id}`);
  console.log(`  estado ...... ${pedido.status} / ${pedido.status_detail}`);
  console.log(`  pagamento ... ${pagamento?.id ?? '(nenhum)'} (${pagamento?.status ?? '?'})`);
  conferir('veio o "copia e cola" (qr_code)', typeof metodo.qr_code === 'string' && metodo.qr_code.length > 20,
    'payment_method.qr_code ausente');
  conferir('veio a imagem do QR (qr_code_base64)',
    typeof metodo.qr_code_base64 === 'string' && metodo.qr_code_base64.length > 100,
    'payment_method.qr_code_base64 ausente');
  if (typeof metodo.qr_code_base64 === 'string') {
    console.log(`  tamanho da imagem em base64: ${metodo.qr_code_base64.length} caracteres`);
  }
  conferir('a referência voltou igual à enviada', pedido.external_reference === referencia);

  console.log('\n3. Esperar o pedido de teste se aprovar sozinho (até 2 minutos)');
  const inicio = Date.now();
  let atual = pedido;
  let ultimo = `${pedido.status}/${pedido.status_detail}`;
  while (Date.now() - inicio < ESPERA_MAXIMA_MS && atual.status !== 'processed') {
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
    const lido = await chamar('GET', `/v1/orders/${encodeURIComponent(pedido.id)}`);
    if (lido.status !== 200) {
      console.log(`  GET /v1/orders/{id} respondeu HTTP ${lido.status}: ${resumoDoErro(lido.json)}`);
      continue;
    }
    atual = lido.json;
    const agora = `${atual.status}/${atual.status_detail}`;
    if (agora !== ultimo) {
      console.log(`  ${Math.round((Date.now() - inicio) / 1000)} s: ${agora} (pagamento ${pagamentoDoPedido(atual)?.status})`);
      ultimo = agora;
    }
  }
  const segundos = Math.round((Date.now() - inicio) / 1000);
  conferir(`o pedido foi aprovado (processed) em até 2 minutos — ${segundos} s`, atual.status === 'processed',
    `ficou em ${ultimo}`);
  const pagamentoFinal = pagamentoDoPedido(atual);
  console.log(`  pagamento: ${pagamentoFinal?.id} — ${pagamentoFinal?.status} / ${pagamentoFinal?.status_detail}`);
  console.log(`  valor do pedido: ${atual.total_amount} (${atual.currency ?? 'moeda não informada'})`);

  console.log('\n4. (b) A busca de pagamentos por referência acha o Pix?');
  const achados = await gateway.pagamentosDaReferencia(referencia);
  console.log(`  pagamentos achados por external_reference: ${achados.length}`);
  for (const p of achados) console.log(`  - ${p.id}: ${p.status}, ${p.valorCentavos} centavos ${p.moeda}`);
  console.log(achados.length > 0
    ? '  → a reconciliação da expiração já enxerga o Pix: não precisa mudar.'
    : '  → a reconciliação NÃO enxerga o Pix: precisa da P3 (consultar o pedido).');

  console.log(falhas === 0 ? '\nPix aprovado no sandbox.\n' : `\nPix com ${falhas} falha(s).\n`);
  process.exitCode = falhas === 0 ? 0 : 1;
}

principal().catch((erro) => {
  if (erro instanceof Parada) {
    console.error(`\n${erro.message}\n`);
  } else {
    console.error('\nFalha inesperada:', erro.message, '\n');
  }
  process.exitCode = 1;
});
