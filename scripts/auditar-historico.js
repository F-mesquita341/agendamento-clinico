'use strict';

/**
 * Procura credenciais em TODO o histórico do Git — Etapa 10.
 *
 * O repositório é público. Apagar um segredo num commit novo não o tira do
 * histórico: quem clonar ainda o encontra no commit em que ele entrou. Este
 * script lê cada linha acrescentada em cada commit de todas as referências, e
 * o nome de cada arquivo que já existiu.
 *
 * Uso:
 *
 *   npm run auditar:historico
 *
 * Relata commit, arquivo, linha e o TIPO do achado — NUNCA o valor. Um
 * relatório que repetisse o segredo espalharia a exposição que ele existe para
 * detectar. Sai com código 1 se achar algo.
 *
 * O que procura:
 *   - arquivo .env versionado (o .env.example é o modelo, e é permitido);
 *   - arquivo de chave (.pem, .key, .p12, .pfx) e JSON de conta de serviço;
 *   - bloco de chave privada;
 *   - token do Mercado Pago, pela estrutura (APP_USR-/TEST- com 32 dígitos
 *     hexadecimais no meio);
 *   - URL do PostgreSQL com senha — fora os bancos locais e descartáveis, como
 *     o postgres:postgres@localhost da integração contínua;
 *   - senha do Neon (npg_...) e token do GitHub;
 *   - valor atribuído a uma variável secreta (MERCADO_PAGO_*, FIREBASE_PRIVATE_KEY,
 *     SEGREDO_PSEUDONIMIZACAO, DATABASE_URL*) em arquivo de configuração. Em
 *     código, só quando o valor tem forma de segredo gerado — os testes
 *     atribuem valores falsos a essas variáveis de propósito.
 *
 * O que NÃO é acusado: a configuração do app Web do Firebase (apiKey "AIza…",
 * appId, VAPID) é pública por natureza — feita para ficar embutida na página.
 *
 * Limites: merges sem resolução manual de conflito não acrescentam linhas e não
 * são lidos; arquivos binários só são conferidos pelo nome. Commits que nunca
 * saíram da máquina (desfeitos antes do push) não estão em referência nenhuma
 * e ficam de fora — nem o GitHub os tem.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const RAIZ = path.resolve(__dirname, '..');

const EXTENSOES_DE_CODIGO = new Set(['.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx']);

// Palavras que marcam um valor como exemplo, e não como credencial.
const MARCADOR_DE_EXEMPLO = /exemplo|example|falso|fake|mentira|nao-real|placeholder|usuario|senha|password|xxx/i;

const PADROES = [
  { tipo: 'bloco de chave privada', regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  {
    tipo: 'token do Mercado Pago',
    regex: /\b(?:APP_USR|TEST)-\d{6,}-\d{6}-[0-9a-f]{32}-\d{6,}\b/,
  },
  { tipo: 'senha do Neon', regex: /\bnpg_[A-Za-z0-9]{12,}\b/ },
  { tipo: 'JSON de conta de serviço', regex: /"type"\s*:\s*"service_account"/ },
  { tipo: 'token do GitHub', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
];

// O host para antes da porta: `localhost:5432` precisa ser reconhecido como
// `localhost`.
const URL_POSTGRES = /postgres(?:ql)?:\/\/([^\s:/@'"`]+):([^\s@'"`]+)@([^\s/?:'"`]+)/g;

const VARIAVEL_SECRETA =
  /\b(MERCADO_PAGO_ACCESS_TOKEN|MERCADO_PAGO_SEGREDO_WEBHOOK|FIREBASE_PRIVATE_KEY|SEGREDO_PSEUDONIMIZACAO|DATABASE_URL(?:_TESTE)?)\b\s*[=:]\s*(['"`]?)([^\s'"`,;)]*)/g;

/** Host de banco local ou de exemplo — o da CI, o do .env.example, o dos testes. */
function hostDeExemplo(host) {
  return /^(localhost|127\.0\.0\.1|host(\..*)?)$/.test(host) || /exemplo|example|\$\{/.test(host);
}

/** Senha que não é senha: marcador, variável, ou curta demais para ser gerada. */
function senhaDeExemplo(senha) {
  return MARCADOR_DE_EXEMPLO.test(senha) || /^[$<{]/.test(senha) || senha.length < 8;
}

function valorDeExemplo(valor) {
  return (
    valor === '' ||
    valor === '...' ||
    MARCADOR_DE_EXEMPLO.test(valor) ||
    /^[$<{]/.test(valor) ||
    /^postgres(ql)?:/.test(valor) // quem julga URL de banco é a regra própria dela
  );
}

/** Forma de segredo gerado: 32 ou mais dígitos hexadecimais. */
function formaDeSegredoGerado(valor) {
  return /^[0-9a-f]{32,}$/i.test(valor);
}

/**
 * Tipos de achado numa linha acrescentada. Só os tipos — o valor não sai
 * daqui.
 */
function examinarLinha(linha, arquivo) {
  const tipos = PADROES.filter((p) => p.regex.test(linha)).map((p) => p.tipo);

  for (const [, , senha, host] of linha.matchAll(URL_POSTGRES)) {
    if (!hostDeExemplo(host) && !senhaDeExemplo(senha)) {
      tipos.push('URL do PostgreSQL com senha');
      break;
    }
  }

  const emCodigo = EXTENSOES_DE_CODIGO.has(path.extname(arquivo).toLowerCase());
  for (const [, , aspas, valor] of linha.matchAll(VARIAVEL_SECRETA)) {
    // Em código, `DATABASE_URL: z.string()` é declaração, não valor: sem
    // aspas, não há literal para julgar.
    if (emCodigo ? aspas && formaDeSegredoGerado(valor) : !valorDeExemplo(valor)) {
      tipos.push('valor em variável secreta');
      break;
    }
  }

  return tipos;
}

/** Tipos de achado no próprio nome de um arquivo que já existiu. */
function examinarCaminho(arquivo) {
  const nome = path.posix.basename(arquivo);
  const tipos = [];
  if (/^\.env/.test(nome) && nome !== '.env.example') tipos.push('arquivo .env versionado');
  if (/\.(pem|key|p12|pfx)$/i.test(nome)) tipos.push('arquivo de chave');
  if (/(firebase-adminsdk|service[-_]?account).*\.json$/i.test(nome)) {
    tipos.push('JSON de conta de serviço');
  }
  return tipos;
}

/**
 * Lê o histórico como um fluxo — num repositório grande, o texto inteiro não
 * caberia na memória de uma vez.
 *
 * @returns {Promise<{ commits: number, achados: Array<{ commit, arquivo, linha, tipo }> }>}
 */
function auditar({ raiz = RAIZ } = {}) {
  return new Promise((resolve, reject) => {
    const git = spawn(
      'git',
      [
        '-c',
        'core.quotePath=false',
        'log',
        '--all',
        '-p',
        '-U0',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--format=%x00%H',
      ],
      { cwd: raiz }
    );

    const achados = [];
    const vistos = new Set();
    let commits = 0;
    let commit = null;
    let arquivo = null;
    let numero = 0;
    let erro = '';

    const registrar = (tipo, linha = null) => {
      const chave = `${commit}\n${arquivo}\n${linha}\n${tipo}`;
      if (vistos.has(chave)) return;
      vistos.add(chave);
      achados.push({ commit, arquivo, linha, tipo });
    };

    git.stderr.on('data', (parte) => {
      erro += parte;
    });
    git.on('error', reject);

    const leitor = readline.createInterface({ input: git.stdout, crlfDelay: Infinity });

    leitor.on('line', (texto) => {
      if (texto.startsWith('\0')) {
        commit = texto.slice(1);
        commits += 1;
        return;
      }
      const cabecalho = /^diff --git a\/(.+) b\/(.+)$/.exec(texto);
      if (cabecalho) {
        arquivo = cabecalho[2];
        for (const tipo of examinarCaminho(cabecalho[1])) registrar(tipo);
        for (const tipo of examinarCaminho(arquivo)) registrar(tipo);
        return;
      }
      const trecho = /^@@ -\S+ \+(\d+)/.exec(texto);
      if (trecho) {
        numero = Number(trecho[1]);
        return;
      }
      if (texto.startsWith('+') && !texto.startsWith('+++')) {
        for (const tipo of examinarLinha(texto.slice(1), arquivo)) registrar(tipo, numero);
        numero += 1;
      }
    });

    // Termina quando o git saiu E a última linha foi lida — nessa ordem ou na
    // outra. Resolver só na saída do git arriscaria perder o fim do histórico.
    let codigoDoGit;
    let leituraTerminou = false;
    const terminar = () => {
      if (codigoDoGit === undefined || !leituraTerminou) return;
      if (codigoDoGit !== 0) {
        reject(new Error(`git log terminou com código ${codigoDoGit}: ${erro.trim()}`));
        return;
      }
      resolve({ commits, achados });
    };
    leitor.on('close', () => {
      leituraTerminou = true;
      terminar();
    });
    git.on('close', (codigo) => {
      codigoDoGit = codigo;
      terminar();
    });
  });
}

function relatorio({ commits, achados }) {
  const linhas = [`\nHistórico do Git: ${commits} commit(s), todas as referências.`];
  if (achados.length === 0) {
    linhas.push('✓ Nenhuma credencial encontrada.');
  } else {
    linhas.push(`✗ ${achados.length} achado(s). O valor nunca é mostrado — abra o arquivo no commit indicado.`);
    for (const a of achados) {
      const onde = a.linha ? `${a.arquivo}:${a.linha}` : a.arquivo;
      linhas.push(`  ${a.commit.slice(0, 10)}  ${onde}  ${a.tipo}`);
    }
    linhas.push(
      '',
      'O que resolve é TROCAR a credencial: reescrever o histórico não desfaz uma',
      'exposição que já foi publicada — o valor pode ter sido copiado antes.'
    );
  }
  linhas.push(
    '',
    'A configuração do app Web do Firebase (apiKey, appId, VAPID) é pública e não é acusada.',
    ''
  );
  return linhas.join('\n');
}

async function principal() {
  const resultado = await auditar();
  console.log(relatorio(resultado));
  if (resultado.achados.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  principal().catch((erro) => {
    console.error(erro.message);
    process.exitCode = 1;
  });
}

module.exports = { auditar, examinarLinha, examinarCaminho, relatorio };
