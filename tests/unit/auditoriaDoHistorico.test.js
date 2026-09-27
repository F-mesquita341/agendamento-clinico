'use strict';

/**
 * O auditor do histórico do Git (Etapa 10).
 *
 * Os "segredos" daqui são montados em tempo de execução, em pedaços. Escritos
 * por inteiro, este arquivo seria acusado pelo próprio auditor assim que
 * entrasse no histórico — e com razão: ele não tem como saber que são falsos.
 *
 * Os casos que NÃO podem ser acusados vêm do histórico real do projeto: o
 * banco da integração contínua, o modelo do .env.example, os valores falsos
 * que os testes de configuração atribuem de propósito.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  auditar,
  examinarLinha,
  examinarCaminho,
  relatorio,
  ExcecaoInvalida,
} = require('../../scripts/auditar-historico');

const BLOCO_DE_CHAVE = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
const HEX_32 = '0123456789abcdef'.repeat(2);
const TOKEN_MP = ['APP_USR', '1234567890123456', '092026', HEX_32, '987654321'].join('-');
const SEGREDO_GERADO = HEX_32.repeat(2);
const URL_REAL = ['postgresql:', '', `neondb_owner:${'Xy7kP2mQ9vLr'}@ep-quieto-sol-123456.sa-east-1.aws.neon.tech`, 'banco'].join('/');

/**
 * git num repositório descartável, com configuração própria, para o teste não
 * depender da máquina: autor, fim de linha e assinatura.
 */
function gitEm(pasta, ...args) {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Teste',
      '-c', 'user.email=teste@example.com',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false',
      ...args,
    ],
    { cwd: pasta, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

describe('o que é acusado', () => {
  test.each([
    ['bloco de chave privada', 'bloco de chave privada', BLOCO_DE_CHAVE, 'x.txt'],
    ['token do Mercado Pago em código', 'token do Mercado Pago', `const t = '${TOKEN_MP}';`, 'x.js'],
    ['senha do Neon', 'senha do Neon', `senha: ${'npg_'}AbCdEf123456`, 'x.md'],
    ['JSON de conta de serviço', 'JSON de conta de serviço', `{ "type": "${'service'}_account" }`, 'x.json'],
    ['token do GitHub', 'token do GitHub', `${'ghp_'}${'A1b2C3'.repeat(6)}`, 'x.md'],
    ['token refinado do GitHub', 'token do GitHub', `${'github'}_pat_${'11AB2CD3E'.repeat(2)}0XYZ_${'aB3'.repeat(20)}`, 'x.md'],
    ['URL do banco com senha no .env', 'URL do PostgreSQL com senha', `DATABASE_URL=${URL_REAL}`, '.env'],
    ['segredo no .env', 'valor em variável secreta', `${'MERCADO_PAGO_SEGREDO_WEBHOOK'}=${SEGREDO_GERADO}`, '.env'],
    ['segredo num YAML', 'valor em variável secreta', `  ${'MERCADO_PAGO_SEGREDO_WEBHOOK'}: ${SEGREDO_GERADO}`, 'x.yaml'],
    // Em código e em texto corrido, só o valor com forma de segredo gerado.
    ['segredo gerado em código', 'valor em variável secreta', `${'SEGREDO_PSEUDONIMIZACAO'}: '${SEGREDO_GERADO}',`, 'x.js'],
    ['segredo colado na documentação', 'valor em variável secreta', `${'MERCADO_PAGO_SEGREDO_WEBHOOK'}=${SEGREDO_GERADO}`, 'docs/diario.md'],
  ])('%s', (_rotulo, tipo, linha, arquivo) => {
    expect(examinarLinha(linha, arquivo)).toContain(tipo);
  });

  test.each([
    ['.env', 'arquivo .env versionado'],
    ['config/.env.producao', 'arquivo .env versionado'],
    ['.env.bak', 'arquivo .env versionado'],
    ['certificado.pem', 'arquivo de chave'],
    ['credenciais/servidor.key', 'arquivo de chave'],
    ['agendamento-clinico-bd390-firebase-adminsdk-abc12-1234567890.json', 'JSON de conta de serviço'],
    ['serviceAccount.json', 'JSON de conta de serviço'],
  ])('o arquivo %s', (arquivo, tipo) => {
    expect(examinarCaminho(arquivo)).toContain(tipo);
  });
});

describe('o que não é acusado', () => {
  test.each([
    ['o banco da integração contínua', 'DATABASE_URL_TESTE: postgresql://postgres:postgres@localhost:5432/agendamento_teste', 'ci.yml'],
    ['o modelo do .env.example', '# postgresql://usuario:senha@host.neon.tech/nome_do_banco?sslmode=require', '.env.example'],
    ['a URL montada nos testes', 'const DIRETO = `postgresql://u:s@${HOST}/agendamento`;', 'config.test.js'],
    ['variável vazia no modelo', 'MERCADO_PAGO_ACCESS_TOKEN=', '.env.example'],
    ['variável só nomeada no render.yaml', '      - key: MERCADO_PAGO_ACCESS_TOKEN', 'render.yaml'],
    ['declaração no esquema', '  DATABASE_URL: z.string().min(1).optional(),', 'config.js'],
    ['valor falso num teste', "    MERCADO_PAGO_ACCESS_TOKEN: 'credencial-de-exemplo-nao-real',", 'config.test.js'],
    ['valor falso sem a palavra exemplo', "    FIREBASE_PRIVATE_KEY: 'segredo-que-nao-pode-aparecer',", 'config.test.js'],
    // Parece um token, mas o meio são palavras, e não 32 dígitos hexadecimais.
    ['token falso com a forma aproximada', `    MERCADO_PAGO_ACCESS_TOKEN: '${'APP_USR'}-1234567890123456-092026-credencial-invalida-0',`, 'x.test.js'],
    ['o segredo do GitHub Actions', '      MERCADO_PAGO_ACCESS_TOKEN: ${{ secrets.MP_TOKEN }}', 'ci.yml'],
    ['a chave pública do app Web do Firebase', `apiKey: '${'AIza'}Sy${'B'.repeat(33)}'`, 'pagina.js'],
    // Frases de documentação. Acusadas, deixariam a integração contínua
    // vermelha para sempre: o histórico não muda.
    ['frase do diário com dois-pontos', 'O MERCADO_PAGO_ACCESS_TOKEN: a credencial da conta de teste vendedora.', 'docs/diario.md'],
    ['frase do diário com igual', 'Troquei o DATABASE_URL=novo no painel do Render.', 'docs/diario.md'],
    ['tabela do README', '| DATABASE_URL: | string de conexão do Neon |', 'README.md'],
    ['exemplo abreviado no README', 'MERCADO_PAGO_ACCESS_TOKEN=APP_USR-...', 'README.md'],
    ['instrução no README', 'SEGREDO_PSEUDONIMIZACAO=cole-aqui-o-que-o-comando-gerou', 'README.md'],
    ['menção ao prefixo do token refinado', 'O auditor reconhece também o formato github_pat_ do GitHub.', 'README.md'],
  ])('%s', (_rotulo, linha, arquivo) => {
    expect(examinarLinha(linha, arquivo)).toEqual([]);
  });

  test.each(['.env.example', 'package.json', 'docs/diario.md', 'src/config.js'])('o arquivo %s', (arquivo) => {
    expect(examinarCaminho(arquivo)).toEqual([]);
  });
});

describe('sobre um repositório de verdade', () => {
  let pasta;
  const commits = {};

  const git = (...args) => gitEm(pasta, ...args);

  function gravar(arquivo, conteudo) {
    fs.mkdirSync(path.dirname(path.join(pasta, arquivo)), { recursive: true });
    fs.writeFileSync(path.join(pasta, arquivo), conteudo);
  }

  function commitar(mensagem) {
    git('add', '-A', '-f', '.');
    git('commit', '-q', '-m', mensagem);
    return git('rev-parse', 'HEAD');
  }

  beforeAll(() => {
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'historico-'));
    git('init', '-q', '-b', 'principal');

    gravar('README.md', 'projeto\n');
    commits.limpo = commitar('limpo');

    gravar('.env', `${'MERCADO_PAGO_SEGREDO_WEBHOOK'}=${SEGREDO_GERADO}\n`);
    gravar('src/chave.js', `// chave\nconst k = \`${BLOCO_DE_CHAVE}\`;\n`);
    commits.vazamento = commitar('vazamento');

    // Apagar num commit novo não tira do histórico. (O -f do `add`, em
    // commitar, é porque o .gitignore global da máquina pode ignorar .env.)
    git('rm', '-q', '.env');
    gravar('src/chave.js', '// chave removida\n');
    commits.remocao = commitar('remove');

    // Um ramo que nunca foi juntado também é lido.
    git('checkout', '-q', '-b', 'experimento');
    gravar('docs/notas.md', `token: ${TOKEN_MP}\n`);
    commits.ramo = commitar('experimento');
    git('checkout', '-q', 'principal');

    // Um .env renomeado: o achado do renomeio sai com o nome antigo.
    gravar('.env.local', 'A=1\nB=2\nC=3\n');
    commits.envLocal = commitar('env local');
    git('mv', '.env.local', 'config.txt');
    commits.renomeio = commitar('renomeia');
  });

  afterAll(() => {
    fs.rmSync(pasta, { recursive: true, force: true });
  });

  test('lê todos os commits, de todos os ramos', async () => {
    const { commits: lidos } = await auditar({ raiz: pasta });

    expect(lidos).toBe(6);
  });

  test('no renomeio, o achado sai com o nome antigo, e o novo não é acusado', async () => {
    const { achados } = await auditar({ raiz: pasta });
    const doRenomeio = achados.filter((a) => a.commit === commits.renomeio);

    expect(doRenomeio).toEqual([
      { commit: commits.renomeio, arquivo: '.env.local', linha: null, tipo: 'arquivo .env versionado' },
    ]);
    expect(achados.filter((a) => a.arquivo === 'config.txt')).toEqual([]);
  });

  test('acha o que foi apagado depois, e o que está num ramo não juntado', async () => {
    const { achados } = await auditar({ raiz: pasta });

    expect(achados).toEqual(
      expect.arrayContaining([
        { commit: commits.vazamento, arquivo: '.env', linha: null, tipo: 'arquivo .env versionado' },
        { commit: commits.vazamento, arquivo: '.env', linha: 1, tipo: 'valor em variável secreta' },
        { commit: commits.vazamento, arquivo: 'src/chave.js', linha: 2, tipo: 'bloco de chave privada' },
        { commit: commits.ramo, arquivo: 'docs/notas.md', linha: 1, tipo: 'token do Mercado Pago' },
      ])
    );
  });

  test('nem o resultado nem o relatório carregam o valor encontrado', async () => {
    const resultado = await auditar({ raiz: pasta });
    const texto = JSON.stringify(resultado) + relatorio(resultado);

    for (const valor of [SEGREDO_GERADO, BLOCO_DE_CHAVE, TOKEN_MP, HEX_32]) {
      expect(texto).not.toContain(valor);
    }
  });

  test('o relatório aponta commit, arquivo e linha', async () => {
    const texto = relatorio(await auditar({ raiz: pasta }));

    expect(texto).toContain(`${commits.vazamento.slice(0, 10)}  src/chave.js:2  bloco de chave privada`);
    expect(texto).toMatch(/TROCAR a credencial/);
  });

  describe('exceções revisadas', () => {
    const excecao = () => ({
      commit: commits.vazamento.slice(0, 10),
      arquivo: 'src/chave.js',
      linha: 2,
      tipo: 'bloco de chave privada',
      motivo: 'Chave de exemplo do próprio teste.',
    });

    test('tiram exatamente o achado delas, e o relatório diz quantos', async () => {
      const r = await auditar({ raiz: pasta, excecoes: [excecao()] });

      expect(r.aceitos).toBe(1);
      expect(r.semUso).toEqual([]);
      expect(r.achados).not.toContainEqual(expect.objectContaining({ arquivo: 'src/chave.js' }));
      // O resto continua acusado.
      expect(r.achados).toContainEqual(
        expect.objectContaining({ commit: commits.vazamento, arquivo: '.env', linha: 1 })
      );
      expect(relatorio(r)).toMatch(/1 falso\(s\) positivo\(s\) já revisado/);
    });

    test('a que não coincide em tudo não tira nada, e é apontada como sem uso', async () => {
      const r = await auditar({ raiz: pasta, excecoes: [{ ...excecao(), linha: 3 }] });

      expect(r.aceitos).toBe(0);
      expect(r.achados).toContainEqual(expect.objectContaining({ arquivo: 'src/chave.js', linha: 2 }));
      expect(r.semUso).toHaveLength(1);
      expect(relatorio(r)).toMatch(/sem achado correspondente/);
    });

    test.each([
      ['sem motivo', { motivo: undefined }],
      ['com motivo vazio', { motivo: '   ' }],
      ['com hash curto', { commit: 'abc123' }],
      ['com tipo inventado', { tipo: 'coisa suspeita' }],
      ['com linha em texto', { linha: '2' }],
    ])('exceção %s é recusada antes de ler o histórico', async (_rotulo, troca) => {
      await expect(auditar({ raiz: pasta, excecoes: [{ ...excecao(), ...troca }] })).rejects.toThrow(
        ExcecaoInvalida
      );
    });

    test('a lista versionada do projeto é válida', async () => {
      await expect(
        auditar({ raiz: pasta, excecoes: require('../../scripts/excecoes-da-auditoria') })
      ).resolves.toMatchObject({ commits: 6 });
    });
  });

  test('repositório limpo não tem achado', async () => {
    const limpo = fs.mkdtempSync(path.join(os.tmpdir(), 'historico-limpo-'));
    try {
      gitEm(limpo, 'init', '-q');
      fs.writeFileSync(path.join(limpo, 'a.md'), 'nada aqui\n');
      gitEm(limpo, 'add', '.');
      gitEm(limpo, 'commit', '-q', '-m', 'a');

      const resultado = await auditar({ raiz: limpo });

      expect(resultado).toEqual({ commits: 1, achados: [], aceitos: 0, semUso: [] });
      expect(relatorio(resultado)).toMatch(/✓ Nenhuma credencial encontrada/);
    } finally {
      fs.rmSync(limpo, { recursive: true, force: true });
    }
  });
});
