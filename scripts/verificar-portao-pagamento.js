'use strict';

/**
 * Portão da Etapa 8, contra a API PUBLICADA.
 *
 * Agenda uma consulta com token real do Firebase, pede o pagamento, espera
 * você pagar no Mercado Pago e confere que a consulta é confirmada. Também
 * exige que uma notificação forjada seja recusada, e — com --expiracao — que
 * uma reserva não paga devolva o horário à grade.
 *
 * COMO ELE DISTINGUE WEBHOOK DE RECONCILIAÇÃO. A rotina de reconciliação só
 * age sobre reservas JÁ VENCIDAS (ver ExpirarReservasVencidas.reconciliar). Se
 * a consulta for confirmada enquanto `reservaExpiraEm` ainda está no futuro, a
 * única explicação possível é o webhook. Não é medição de tempo de parede, é
 * critério de estado — e é o que responde se `type=payment` chega na query.
 *
 * Uso, no PowerShell:
 *
 *   $env:FIREBASE_WEB_API_KEY = "..."
 *   $env:SENHA_PACIENTE_A     = "..."
 *   $env:API_URL              = "https://agendamento-clinico-api.onrender.com"
 *   npm run verificar:portao
 *
 * Com a fase de expiração junto (leva RESERVA_MINUTOS + 1 min):
 *
 *   npm run verificar:portao -- --expiracao
 *
 * Nenhuma senha, chave ou token é impresso.
 */

require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { VERSAO_TERMO_CONSENTIMENTO } = require('../src/domain/Paciente');

const API = process.env.API_URL ?? `http://localhost:${process.env.PORTA ?? 3000}`;
const CHAVE = process.env.FIREBASE_WEB_API_KEY;
const PACIENTE = {
  email: process.env.EMAIL_PACIENTE_A ?? 'paciente.a@example.com',
  senha: process.env.SENHA_PACIENTE_A,
  nome: 'Paciente A de Teste',
};

const COM_EXPIRACAO = process.argv.includes('--expiracao');
// A primeira requisição acorda o serviço adormecido do plano gratuito, e isso
// leva perto de um minuto. As demais não precisam de tanta paciência.
const PRAZO_DA_ACORDADA_MS = 120_000;
const PRAZO_MS = 30_000;
const INTERVALO_DA_ESPERA_MS = 3_000;
const ESPERA_MAXIMA_PELO_PAGAMENTO_MS = 12 * 60_000;

let falhas = 0;

function conferir(descricao, condicao, detalhe = '') {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}${!condicao && detalhe ? ` — ${detalhe}` : ''}`);
  if (!condicao) falhas += 1;
  return condicao;
}

class Parada extends Error {}

function abortar(mensagem) {
  throw new Parada(mensagem);
}

function minutos(ms) {
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

async function api(metodo, caminho, { token, corpo, prazoMs = PRAZO_MS } = {}) {
  let resposta;
  try {
    resposta = await fetch(`${API}${caminho}`, {
      method: metodo,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(prazoMs),
    });
  } catch (erro) {
    if (erro.name === 'TimeoutError') {
      abortar(
        `A API não respondeu a ${metodo} ${caminho} em ${prazoMs / 1000} s.\n` +
          'No plano gratuito do Render o serviço hiberna: tente de novo, que a\n' +
          'primeira requisição costuma acordá-lo.'
      );
    }
    const causa = erro.cause ? `${erro.cause.code ?? ''} ${erro.cause.message ?? ''}`.trim() : erro.message;
    abortar(`A API não respondeu a ${metodo} ${caminho} (${causa}).`);
  }
  const texto = await resposta.text();
  return { status: resposta.status, corpo: texto ? JSON.parse(texto) : null };
}

async function tokenReal() {
  const resposta = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(CHAVE)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: PACIENTE.email, password: PACIENTE.senha, returnSecureToken: true }),
      signal: AbortSignal.timeout(PRAZO_MS),
    }
  );
  const corpo = await resposta.json();
  // O Firebase devolve só um código, como INVALID_LOGIN_CREDENTIALS: seguro de
  // exibir, não contém senha nem chave.
  if (!resposta.ok) abortar(`O Firebase recusou a autenticação: ${corpo?.error?.message ?? resposta.status}`);
  return corpo.idToken;
}

async function garantirPerfil(token) {
  const leitura = await api('GET', '/pacientes/me', { token });
  if (leitura.status === 200) return;

  if (leitura.corpo?.erro?.codigo === 'PERFIL_NAO_CADASTRADO') {
    const cadastro = await api('POST', '/pacientes', {
      token,
      corpo: {
        nome: PACIENTE.nome,
        consentimento: { aceito: true, versao: VERSAO_TERMO_CONSENTIMENTO },
      },
    });
    conferir('perfil cadastrado na API publicada', cadastro.status === 201, `HTTP ${cadastro.status}`);
    return;
  }
  abortar(`GET /pacientes/me respondeu HTTP ${leitura.status} — não dá para seguir.`);
}

/** Agenda no primeiro horário livre da grade e devolve a consulta criada. */
async function agendar(token, rotulo) {
  const catalogo = await api('GET', '/profissionais', { token });
  const profissional = catalogo.corpo?.profissionais?.[0];
  if (!profissional) abortar('Nenhum profissional no catálogo. O banco de produção foi semeado?');

  const grade = await api('GET', `/profissionais/${profissional.id}/horarios`);
  const horario = grade.corpo?.horarios?.[0];
  if (!horario) abortar(`${profissional.nome} está sem horários livres na grade.`);

  const criada = await api('POST', '/consultas', {
    token,
    corpo: { horarioId: horario.id, versao: horario.versao },
  });
  if (!conferir(`${rotulo}: agendada → 201`, criada.status === 201, `HTTP ${criada.status}`)) {
    abortar('Sem consulta agendada não há portão a verificar.');
  }
  const consulta = criada.corpo.consulta;
  conferir(`${rotulo}: nasce aguardando pagamento`, consulta.status === 'pendente_pagamento', consulta.status);
  return { consulta, horario, profissional };
}

/** Uma notificação inventada, com assinatura que não vem de chave nenhuma. */
async function notificacaoForjada() {
  const assinatura = crypto.randomBytes(32).toString('hex');
  const resposta = await fetch(
    `${API}/webhooks/mercadopago?type=payment&data.id=999999999`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': crypto.randomUUID(),
        'x-signature': `ts=${Math.floor(Date.now() / 1000)},v1=${assinatura}`,
      },
      body: JSON.stringify({ action: 'payment.updated', type: 'payment', data: { id: '999999999' } }),
      signal: AbortSignal.timeout(PRAZO_MS),
    }
  );
  return { status: resposta.status, corpo: await resposta.json().catch(() => null) };
}

/**
 * Acompanha a consulta até ela sair de `pendente_pagamento`.
 *
 * @returns {Promise<{consulta: object, antesDoVencimento: boolean, levou: number}>}
 */
async function esperarMudanca(token, consultaId, { prazoMs, vencimento, aoEsperar }) {
  const comeco = Date.now();
  let ultimoAviso = 0;

  for (;;) {
    const leitura = await api('GET', `/consultas/${consultaId}`, { token });
    const consulta = leitura.corpo?.consulta;
    if (consulta && consulta.status !== 'pendente_pagamento') {
      return {
        consulta,
        antesDoVencimento: Date.now() < vencimento.getTime(),
        levou: Date.now() - comeco,
      };
    }

    if (Date.now() - comeco > prazoMs) {
      return { consulta, antesDoVencimento: false, levou: Date.now() - comeco, estourou: true };
    }
    if (aoEsperar && Date.now() - ultimoAviso > 30_000) {
      ultimoAviso = Date.now();
      aoEsperar(Date.now() - comeco);
    }
    await new Promise((r) => setTimeout(r, INTERVALO_DA_ESPERA_MS));
  }
}

async function principal() {
  const ausentes = [
    ['FIREBASE_WEB_API_KEY', CHAVE],
    ['SENHA_PACIENTE_A', PACIENTE.senha],
  ].filter(([, valor]) => !valor);
  if (ausentes.length) {
    abortar(
      `Defina no terminal antes de rodar: ${ausentes.map(([n]) => n).join(', ')}.\n` +
        'Veja as instruções no topo de scripts/verificar-portao-pagamento.js.'
    );
  }

  console.log(`\nAPI: ${API}`);

  console.log('\n1. A API está de pé');
  const saude = await api('GET', '/saude', { prazoMs: PRAZO_DA_ACORDADA_MS });
  conferir('GET /saude → 200', saude.status === 200, `HTTP ${saude.status}`);
  conferir('o banco responde', saude.corpo?.banco === 'conectado', JSON.stringify(saude.corpo));

  console.log('\n2. Token real do Firebase');
  const token = await tokenReal();
  conferir(`token emitido para ${PACIENTE.email}`, Boolean(token));
  await garantirPerfil(token);

  console.log('\n3. Notificação forjada');
  const forjada = await notificacaoForjada();
  conferir('assinatura inventada → 401', forjada.status === 401, `HTTP ${forjada.status}`);
  conferir(
    'a recusa não explica o que corrigir',
    forjada.corpo?.erro?.codigo === 'ASSINATURA_INVALIDA' && !forjada.corpo?.erro?.motivo
  );

  console.log('\n4. Agendamento');
  const { consulta, horario, profissional } = await agendar(token, 'consulta');

  console.log('\n5. Pedido de pagamento');
  const pedido = await api('POST', `/consultas/${consulta.id}/pagamento`, { token });
  if (!conferir('checkout aberto → 201', pedido.status === 201, `HTTP ${pedido.status}`)) {
    abortar(`A API respondeu: ${JSON.stringify(pedido.corpo)}`);
  }
  const checkout = pedido.corpo.pagamento;
  conferir('veio endereço de pagamento', Boolean(checkout.checkoutUrl));
  conferir(
    'o valor cobrado é o da consulta',
    checkout.valorCentavos === consulta.valorCentavos,
    `${checkout.valorCentavos} ≠ ${consulta.valorCentavos}`
  );
  conferir(
    'o checkout expira junto com a reserva',
    checkout.expiraEm === consulta.reservaExpiraEm,
    `${checkout.expiraEm} ≠ ${consulta.reservaExpiraEm}`
  );

  const denovo = await api('POST', `/consultas/${consulta.id}/pagamento`, { token });
  conferir('pedir de novo reaproveita o checkout → 200', denovo.status === 200, `HTTP ${denovo.status}`);
  conferir(
    'e devolve o MESMO endereço — dois abertos permitiriam pagar duas vezes',
    denovo.corpo?.pagamento?.checkoutUrl === checkout.checkoutUrl
  );

  const vencimento = new Date(consulta.reservaExpiraEm);
  console.log(
    `\n6. Agora pague\n` +
      `  ${profissional.nome} — ${checkout.valorFormatado}\n` +
      `  horário ${new Date(horario.inicio).toLocaleString('pt-BR')}\n\n` +
      `  ${checkout.checkoutUrl}\n\n` +
      '  Numa janela ANÔNIMA, entre com a conta de teste COMPRADORA e pague.\n' +
      `  A reserva vence em ${vencimento.toLocaleTimeString('pt-BR')}.\n`
  );

  const desfecho = await esperarMudanca(token, consulta.id, {
    prazoMs: ESPERA_MAXIMA_PELO_PAGAMENTO_MS,
    vencimento,
    aoEsperar: (decorrido) => console.log(`  ... esperando há ${minutos(decorrido)}`),
  });

  console.log('\n7. Resultado');
  if (desfecho.estourou) {
    conferir(
      `a consulta foi confirmada (esperei ${minutos(desfecho.levou)})`,
      false,
      `continua ${desfecho.consulta?.status}`
    );
  } else {
    conferir('a consulta foi confirmada', desfecho.consulta.status === 'confirmada', desfecho.consulta.status);
    console.log(`  levou ${minutos(desfecho.levou)}`);

    // A reconciliação só age sobre reservas JÁ VENCIDAS. Confirmação antes do
    // vencimento só pode ter vindo do webhook.
    if (desfecho.antesDoVencimento) {
      console.log('  ✓ confirmada ANTES do vencimento da reserva: foi o webhook');
    } else {
      falhas += 1;
      console.log(
        '  ✗ confirmada só DEPOIS do vencimento: foi a reconciliação, não o webhook.\n' +
          '    O aviso do Mercado Pago não chegou ou foi descartado. Olhe o log do\n' +
          '    Render: a rota registra o tipo recebido e os parâmetros da query.'
      );
    }
  }

  if (COM_EXPIRACAO) {
    console.log('\n8. Reserva abandonada');
    const segunda = await agendar(token, 'segunda consulta');
    const venceEm = new Date(segunda.consulta.reservaExpiraEm);
    const espera = venceEm.getTime() - Date.now() + 90_000;
    console.log(
      `  Não pague esta. Vence às ${venceEm.toLocaleTimeString('pt-BR')}; ` +
        `a rotina roda a cada minuto.\n  Esperando ${minutos(Math.max(espera, 0))}...`
    );

    const expirada = await esperarMudanca(token, segunda.consulta.id, {
      prazoMs: Math.max(espera, 0) + 120_000,
      vencimento: venceEm,
      aoEsperar: (decorrido) => console.log(`  ... esperando há ${minutos(decorrido)}`),
    });

    if (expirada.estourou) {
      conferir('a reserva expirou sozinha', false, `continua ${expirada.consulta?.status}`);
    } else {
      conferir('a reserva expirou sozinha', expirada.consulta.status === 'cancelada', expirada.consulta.status);
      conferir(
        'e o motivo registrado distingue de cancelamento do paciente',
        expirada.consulta.motivoCancelamento === 'reserva_expirada',
        String(expirada.consulta.motivoCancelamento)
      );

      const grade = await api('GET', `/profissionais/${segunda.profissional.id}/horarios`);
      const devolvido = (grade.corpo?.horarios ?? []).find((h) => h.id === segunda.horario.id);
      conferir('o horário voltou à grade', Boolean(devolvido));
      conferir(
        'com a versão adiantada, invalidando quem tinha a antiga',
        devolvido ? devolvido.versao > segunda.horario.versao : false
      );
    }
  } else {
    console.log(
      '\n8. Reserva abandonada — pulada.\n' +
        '  Rode com --expiracao para verificar também esta parte do portão.'
    );
  }

  console.log(
    falhas
      ? `\n${falhas} verificação(ões) falharam.\n`
      : '\nPortão da Etapa 8 atingido na API publicada: um pagamento sandbox\n' +
          'aprovado confirma a consulta pelo webhook, uma notificação forjada é\n' +
          'recusada' +
          (COM_EXPIRACAO ? ', e uma reserva não paga devolve o horário à grade.\n' : '.\n')
  );
  process.exitCode = falhas ? 1 : 0;
}

principal().catch((erro) => {
  console.error(erro instanceof Parada ? `\n${erro.message}\n` : `\nFalha inesperada: ${erro.message}\n`);
  process.exitCode = 1;
});
