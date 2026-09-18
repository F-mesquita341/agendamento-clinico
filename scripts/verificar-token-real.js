'use strict';

/**
 * Prova dos portões das Etapas 5 e 6, com tokens REAIS emitidos pelo Firebase.
 *
 * A suíte automatizada usa um verificador de token falso, para rodar sem rede
 * e sem credencial. Este script fecha a lacuna: autentica os dois usuários de
 * teste no Firebase de verdade, chama a API em execução com cada token e
 * confere que cada um só alcança o próprio perfil — e, desde a Etapa 6, que
 * dois pacientes disputando o mesmo horário produzem um agendamento e um 409.
 *
 * Feito para ser executado por você, no seu terminal. Senhas e chave de API
 * entram por variável de ambiente da sessão e nunca são impressas — nem o
 * token.
 *
 * Uso, no PowerShell:
 *
 *   $env:FIREBASE_WEB_API_KEY = "..."
 *   $env:SENHA_PACIENTE_A     = "..."
 *   $env:SENHA_PACIENTE_B     = "..."
 *   npm run verificar:token
 *
 * A API precisa estar rodando em outro terminal (npm run dev). Os dois
 * pacientes de teste ficam cadastrados no banco de desenvolvimento.
 */

require('dotenv').config({ quiet: true });
const { VERSAO_TERMO_CONSENTIMENTO } = require('../src/domain/Paciente');

const API = process.env.API_URL ?? `http://localhost:${process.env.PORTA ?? 3000}`;
const CHAVE = process.env.FIREBASE_WEB_API_KEY;
const USUARIOS = {
  A: {
    email: process.env.EMAIL_PACIENTE_A ?? 'paciente.a@example.com',
    senha: process.env.SENHA_PACIENTE_A,
    nome: 'Paciente A de Teste',
  },
  B: {
    email: process.env.EMAIL_PACIENTE_B ?? 'paciente.b@example.com',
    senha: process.env.SENHA_PACIENTE_B,
    nome: 'Paciente B de Teste',
  },
};

let falhas = 0;

function conferir(descricao, condicao, detalhe = '') {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}${!condicao && detalhe ? ` — ${detalhe}` : ''}`);
  if (!condicao) falhas += 1;
}

function abortar(mensagem) {
  console.error(`\n${mensagem}\n`);
  process.exit(1);
}

async function obterTokenReal(email, senha) {
  const resposta = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(CHAVE)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senha, returnSecureToken: true }),
    }
  );
  const corpo = await resposta.json();
  if (!resposta.ok) {
    // O Firebase devolve só um código, como INVALID_LOGIN_CREDENTIALS. É seguro
    // exibir — não contém senha nem chave.
    throw new Error(corpo?.error?.message ?? `HTTP ${resposta.status}`);
  }
  return corpo.idToken;
}

async function api(metodo, caminho, { token, corpo } = {}) {
  let resposta;
  try {
    resposta = await fetch(`${API}${caminho}`, {
      method: metodo,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch (erro) {
    // "fetch failed" sozinho não diz nada. A causa real — conexão recusada,
    // conexão derrubada no meio — fica em `erro.cause`.
    const causa = erro.cause ? `${erro.cause.code ?? ''} ${erro.cause.message ?? ''}`.trim() : erro.message;
    throw new Error(
      `a API não respondeu a ${metodo} ${caminho} (${causa}). ` +
        'Olhe o terminal onde a API está rodando: ela pode ter caído ou reiniciado.'
    );
  }
  const texto = await resposta.text();
  return { status: resposta.status, corpo: texto ? JSON.parse(texto) : null, texto };
}

/** Lê o próprio perfil; se ainda não existir, cadastra com o termo vigente. */
async function garantirPerfil(rotulo, usuario) {
  const leitura = await api('GET', '/pacientes/me', { token: usuario.token });

  if (leitura.status === 404 && leitura.corpo?.erro?.codigo === 'PERFIL_NAO_CADASTRADO') {
    const cadastro = await api('POST', '/pacientes', {
      token: usuario.token,
      corpo: {
        nome: usuario.nome,
        consentimento: { aceito: true, versao: VERSAO_TERMO_CONSENTIMENTO },
      },
    });
    conferir(`${rotulo}: cadastro com token real → 201`, cadastro.status === 201, `HTTP ${cadastro.status}`);
  } else {
    conferir(`${rotulo}: perfil já existente lido com token real → 200`, leitura.status === 200, `HTTP ${leitura.status}`);
  }

  const perfil = await api('GET', '/pacientes/me', { token: usuario.token });
  conferir(`${rotulo}: GET /pacientes/me → 200`, perfil.status === 200, `HTTP ${perfil.status}`);
  conferir(
    `${rotulo}: o perfil devolvido é o da própria conta (${usuario.email})`,
    perfil.corpo?.paciente?.email === usuario.email
  );
  return perfil;
}

/**
 * Procura um horário livre na grade e faz A e B disputarem-no.
 *
 * Usa a MESMA versão nos dois pedidos, que é o que acontece quando as duas
 * pessoas abriram a tela antes de qualquer uma confirmar. Ao final, cancela o
 * que foi criado: o banco de desenvolvimento volta ao estado anterior.
 */
async function verificarAgendamento() {
  const catalogo = await api('GET', '/profissionais', { token: USUARIOS.A.token });
  const profissional = catalogo.corpo?.profissionais?.[0];
  if (!profissional) {
    console.log('  – nenhum profissional cadastrado; rode "npm run seed" antes.');
    return;
  }

  const grade = await api('GET', `/profissionais/${profissional.id}/horarios`);
  const horario = grade.corpo?.horarios?.[0];
  if (!horario) {
    console.log(`  – ${profissional.nome} está sem horários livres; rode "npm run seed".`);
    return;
  }

  const pedido = { horarioId: horario.id, versao: horario.versao };
  const daA = await api('POST', '/consultas', { token: USUARIOS.A.token, corpo: pedido });
  conferir('A agenda o horário → 201', daA.status === 201, `HTTP ${daA.status}`);
  conferir(
    'a consulta nasce com o preço do profissional',
    daA.corpo?.consulta?.valorCentavos === profissional.valorCentavos,
    `${daA.corpo?.consulta?.valorCentavos} ≠ ${profissional.valorCentavos}`
  );

  // B ainda tem em mãos a versão que leu antes de A confirmar.
  const daB = await api('POST', '/consultas', { token: USUARIOS.B.token, corpo: pedido });
  conferir('B, com a versão antiga, → 409', daB.status === 409, `HTTP ${daB.status}`);
  conferir(
    'o 409 diz ao aplicativo para recarregar a grade',
    daB.corpo?.erro?.acao === 'recarregar_horarios'
  );

  const consultaId = daA.corpo?.consulta?.id;
  // 404, e não 403: consulta alheia responde como se não existisse, para que
  // ninguém possa contar os registros da clínica percorrendo ids.
  const espiada = await api('GET', `/consultas/${consultaId}`, { token: USUARIOS.B.token });
  conferir('B não enxerga a consulta de A → 404', espiada.status === 404, `HTTP ${espiada.status}`);

  const listaDeB = await api('GET', '/consultas', { token: USUARIOS.B.token });
  conferir(
    'a lista de B não contém a consulta de A',
    !(listaDeB.corpo?.consultas ?? []).some((c) => c.id === consultaId)
  );

  const cancelamento = await api('PATCH', `/consultas/${consultaId}/cancelamento`, {
    token: USUARIOS.A.token,
  });
  conferir('A cancela a própria consulta → 200', cancelamento.status === 200, `HTTP ${cancelamento.status}`);

  const gradeDepois = await api('GET', `/profissionais/${profissional.id}/horarios`);
  const devolvido = (gradeDepois.corpo?.horarios ?? []).find((h) => h.id === horario.id);
  conferir('o horário volta à grade com a versão adiantada', devolvido?.versao === horario.versao + 2);
}

async function principal() {
  const ausentes = [
    ['FIREBASE_WEB_API_KEY', CHAVE],
    ['SENHA_PACIENTE_A', USUARIOS.A.senha],
    ['SENHA_PACIENTE_B', USUARIOS.B.senha],
  ].filter(([, valor]) => !valor);

  if (ausentes.length) {
    abortar(
      `Defina no terminal, antes de rodar: ${ausentes.map(([nome]) => nome).join(', ')}.\n` +
        'Veja as instruções no topo de scripts/verificar-token-real.js.'
    );
  }

  console.log(`\nAPI: ${API}`);
  const saude = await api('GET', '/saude').catch(() => null);
  if (!saude || saude.status !== 200) {
    abortar('A API não respondeu em /saude. Suba-a em outro terminal com: npm run dev');
  }

  console.log('\n1. Tokens reais do Firebase');
  for (const [rotulo, usuario] of Object.entries(USUARIOS)) {
    try {
      usuario.token = await obterTokenReal(usuario.email, usuario.senha);
      conferir(`${rotulo}: token emitido pelo Firebase para ${usuario.email}`, true);
    } catch (erro) {
      conferir(`${rotulo}: token emitido pelo Firebase para ${usuario.email}`, false, erro.message);
    }
  }
  if (falhas) abortar('Sem os dois tokens não há o que verificar.');

  console.log('\n2. Cada token autentica de ponta a ponta');
  const perfilA = await garantirPerfil('A', USUARIOS.A);
  const perfilB = await garantirPerfil('B', USUARIOS.B);

  console.log('\n3. Isolamento entre pacientes');
  conferir('o token de A não traz nenhum dado de B', !perfilA.texto.includes(USUARIOS.B.email));
  conferir('o token de B não traz nenhum dado de A', !perfilB.texto.includes(USUARIOS.A.email));
  conferir(
    'A e B resolvem para pacientes diferentes',
    perfilA.corpo?.paciente?.id !== perfilB.corpo?.paciente?.id
  );

  console.log('\n4. Tokens que não devem passar');
  // Troca um caractere no meio da assinatura: o token fica bem formado, mas a
  // assinatura deixa de conferir com as chaves públicas do Google.
  const partes = USUARIOS.A.token.split('.');
  const meio = Math.floor(partes[2].length / 2);
  partes[2] = partes[2].slice(0, meio) + (partes[2][meio] === 'A' ? 'B' : 'A') + partes[2].slice(meio + 1);
  const adulterado = await api('GET', '/pacientes/me', { token: partes.join('.') });
  conferir('token com assinatura adulterada → 401', adulterado.status === 401, `HTTP ${adulterado.status}`);

  const semToken = await api('GET', '/pacientes/me');
  conferir('requisição sem token → 401', semToken.status === 401, `HTTP ${semToken.status}`);

  console.log('\n5. Agendamento disputado, com tokens reais');
  await verificarAgendamento();

  console.log(
    falhas
      ? `\n${falhas} verificação(ões) falharam.\n`
      : '\nPortões das Etapas 5 e 6 atingidos: token real autentica de ponta a ponta,\n' +
          'cada paciente só alcança o que é seu, e dois pedidos pelo mesmo horário\n' +
          'produzem exatamente um agendamento.\n'
  );
  process.exitCode = falhas ? 1 : 0;
}

principal().catch((erro) => {
  console.error(`\nFalha inesperada: ${erro.message}\n`);
  process.exitCode = 1;
});
