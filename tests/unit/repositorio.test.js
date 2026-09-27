'use strict';

/**
 * O que o repositório promete a quem o clona — conferido, e não só escrito.
 *
 * O portão da Etapa 10 é alguém que não conhece o projeto clonar e rodar só
 * com o README. A revisão de 24/09 achou três promessas desalinhadas do que
 * roda: variáveis que o código lê e o .env.example não mostra, uma versão do
 * Node que ninguém testava, e dado de pesquisa sem segunda proteção contra um
 * commit. Corrigidas; estes testes impedem que se desalinhem de novo.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const ler = (arquivo) => fs.readFileSync(path.join(RAIZ, arquivo), 'utf8');

function arquivosJs(pasta) {
  return fs.readdirSync(path.join(RAIZ, pasta), { withFileTypes: true }).flatMap((item) => {
    const caminho = path.join(pasta, item.name);
    if (item.isDirectory()) return arquivosJs(caminho);
    return item.name.endsWith('.js') ? [caminho] : [];
  });
}

describe('.env.example', () => {
  // Lidas pelo código, mas de propósito fora do modelo — cada uma com o porquê.
  const SO_NO_TERMINAL = {
    SENHA_PACIENTE_A: 'senha de conta de teste: só na sessão do terminal, nunca em arquivo',
    SENHA_PACIENTE_B: 'idem',
    EMAIL_PACIENTE_A: 'acompanha a senha, e tem valor padrão',
    EMAIL_PACIENTE_B: 'idem',
    API_URL: 'aponta os scripts de verificação para outra API; tem valor padrão',
    PORTA_PAGINA: 'porta da página de prova; tem valor padrão',
    RENDER_EXTERNAL_URL: 'definida pela própria plataforma',
  };

  const modelo = new Set([...ler('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

  // As do esquema de config.js e as que qualquer arquivo de src/ ou scripts/ lê.
  const doEsquema = [...ler('src/config.js').matchAll(/^ {2}([A-Z][A-Z0-9_]*): z\b/gm)].map((m) => m[1]);
  const lidas = [...arquivosJs('src'), ...arquivosJs('scripts')].flatMap((arquivo) =>
    [...ler(arquivo).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])
  );
  const usadas = [...new Set([...doEsquema, ...lidas])].sort();

  test('o esquema de config.js foi encontrado — senão o teste abaixo não provaria nada', () => {
    expect(doEsquema).toEqual(expect.arrayContaining(['DATABASE_URL', 'POOL_MAXIMO', 'ORIGENS_PERMITIDAS']));
  });

  test('traz toda variável que o código lê, fora as que vivem só no terminal', () => {
    const faltando = usadas.filter((nome) => !modelo.has(nome) && !(nome in SO_NO_TERMINAL));

    expect(faltando).toEqual([]);
  });

  test('não traz senha de conta de teste', () => {
    expect([...modelo].filter((nome) => nome.startsWith('SENHA_'))).toEqual([]);
  });
});

describe('versão do Node', () => {
  test('README, integração contínua, Render e package.json falam da mesma', () => {
    const versoes = {
      readme: /Node\.js (\d+)/.exec(ler('README.md'))?.[1],
      ci: /node-version: '(\d+)'/.exec(ler('.github/workflows/ci.yml'))?.[1],
      render: /key: NODE_VERSION\s+value: '(\d+)'/.exec(ler('render.yaml'))?.[1],
      packageJson: /(\d+)/.exec(JSON.parse(ler('package.json')).engines.node)?.[1],
    };

    expect(new Set(Object.values(versoes))).toEqual(new Set([versoes.ci]));
    expect(versoes.ci).toBeDefined();
  });
});

describe('o que o Git não pode levar', () => {
  test.each([
    ['CSV de pesquisa, em qualquer pasta', 'docs/pesquisa/consultas.csv'],
    ['CSV na raiz', 'eventos.csv'],
    ['.env', '.env'],
    ['cópia de .env', '.env.bak'],
  ])('%s é ignorado', (_rotulo, arquivo) => {
    // `check-ignore` sai com código 0 quando o caminho é ignorado, e lança
    // erro quando não é.
    expect(() => execFileSync('git', ['check-ignore', '-q', arquivo], { cwd: RAIZ })).not.toThrow();
  });

  test('o modelo .env.example não é ignorado', () => {
    expect(() => execFileSync('git', ['check-ignore', '-q', '.env.example'], { cwd: RAIZ })).toThrow();
  });
});
