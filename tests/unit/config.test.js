'use strict';

/**
 * Os guardas de configuração.
 *
 * `config.js` encerra o processo quando a configuração é inválida. O mais
 * importante deles impede que a suíte de testes — que apaga tabelas — aponte
 * para o banco de desenvolvimento. Esse guarda foi verificado à mão quando
 * escrito; aqui ele passa a ser verificado pela suíte, para que ninguém o
 * quebre sem ser avisado.
 *
 * Cada caso roda em um processo filho: o módulo chama `process.exit`, que não
 * pode ser exercitado dentro do processo do Jest. O diretório de trabalho do
 * filho é uma pasta temporária vazia, para que o `dotenv` não encontre o `.env`
 * real do projeto e contamine o cenário.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAMINHO_CONFIG = path.join(__dirname, '..', '..', 'src', 'config.js');

const HOST = 'ep-exemplo.sa-east-1.aws.neon.tech';
const DIRETO = `postgresql://u:s@${HOST}/agendamento?sslmode=verify-full`;
const DIRETO_TESTE = `postgresql://u:s@${HOST}/agendamento_teste?sslmode=verify-full`;
// Mesmo banco do DIRETO, alcançado pelo outro hostname que o Neon oferece.
const VIA_POOLER = `postgresql://u:s@ep-exemplo-pooler.sa-east-1.aws.neon.tech/agendamento?sslmode=verify-full`;

let pastaSemEnv;

beforeAll(() => {
  pastaSemEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
});

afterAll(() => {
  fs.rmSync(pastaSemEnv, { recursive: true, force: true });
});

/** Carrega config.js num processo limpo e devolve saída e código de retorno. */
function carregarConfig(variaveis) {
  const ambiente = { ...process.env };
  // Remove qualquer resquício do ambiente do Jest, para que só o cenário valha.
  for (const chave of [
    'NODE_ENV',
    'DATABASE_URL',
    'DATABASE_URL_TESTE',
    'TRANSPORTE_BANCO',
    'POOL_MAXIMO',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
  ]) {
    delete ambiente[chave];
  }

  const resultado = spawnSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(CAMINHO_CONFIG)})`],
    {
      cwd: pastaSemEnv,
      env: { ...ambiente, ...variaveis },
      encoding: 'utf8',
    }
  );

  return {
    codigo: resultado.status,
    saida: `${resultado.stdout ?? ''}${resultado.stderr ?? ''}`,
  };
}

describe('guarda contra apagar o banco de desenvolvimento', () => {
  test('recusa quando as duas URLs alcançam o mesmo banco pelo mesmo host', () => {
    const r = carregarConfig({
      NODE_ENV: 'test',
      DATABASE_URL: DIRETO,
      DATABASE_URL_TESTE: DIRETO,
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/MESMO banco/);
  });

  test('recusa quando só o hostname difere — "-pooler" não é outro banco', () => {
    // Este é o caso que uma comparação de texto entre as duas URLs deixaria
    // passar, e que chegou a acontecer de verdade durante a configuração.
    const r = carregarConfig({
      NODE_ENV: 'test',
      DATABASE_URL: DIRETO,
      DATABASE_URL_TESTE: VIA_POOLER,
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/MESMO banco/);
    expect(r.saida).toMatch(/pooler/);
  });

  test('aceita quando os bancos são de fato diferentes', () => {
    const r = carregarConfig({
      NODE_ENV: 'test',
      DATABASE_URL: DIRETO,
      DATABASE_URL_TESTE: DIRETO_TESTE,
    });

    expect(r.codigo).toBe(0);
  });
});

describe('tamanho do pool', () => {
  const base = { NODE_ENV: 'development', DATABASE_URL: DIRETO };

  test('é opcional', () => {
    expect(carregarConfig(base).codigo).toBe(0);
  });

  test('aceita um inteiro dentro do limite', () => {
    expect(carregarConfig({ ...base, POOL_MAXIMO: '10' }).codigo).toBe(0);
  });

  test.each([
    ['texto', 'abc', /POOL_MAXIMO: precisa ser um número/],
    ['zero', '0', /POOL_MAXIMO: precisa ser maior que zero/],
    ['acima do limite do Neon', '500', /POOL_MAXIMO: no máximo 50/],
  ])('recusa %s na subida', (_rotulo, valor, mensagem) => {
    const r = carregarConfig({ ...base, POOL_MAXIMO: valor });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(mensagem);
  });
});

describe('variáveis obrigatórias', () => {
  test('em teste, exige DATABASE_URL_TESTE', () => {
    const r = carregarConfig({ NODE_ENV: 'test', DATABASE_URL: DIRETO });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/DATABASE_URL_TESTE/);
  });

  test('fora de teste, exige DATABASE_URL', () => {
    const r = carregarConfig({ NODE_ENV: 'development' });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/DATABASE_URL não definida/);
  });

  test('na integração contínua, só DATABASE_URL_TESTE basta', () => {
    // O banco do runner é efêmero e descartado ao fim do job, então lá não
    // existe DATABASE_URL — e não deve existir.
    const r = carregarConfig({ NODE_ENV: 'test', DATABASE_URL_TESTE: DIRETO_TESTE });

    expect(r.codigo).toBe(0);
  });
});

describe('transporte do banco', () => {
  test('recusa um valor que não seja tcp nem websocket', () => {
    const r = carregarConfig({
      NODE_ENV: 'test',
      DATABASE_URL_TESTE: DIRETO_TESTE,
      TRANSPORTE_BANCO: 'carruagem',
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/TRANSPORTE_BANCO/);
  });
});

describe('credencial do Firebase', () => {
  /** Chave de conta de serviço com o formato certo e valores de mentira. */
  const CHAVE_DE_EXEMPLO = {
    type: 'service_account',
    project_id: 'projeto-exemplo',
    client_email: 'conta@projeto-exemplo.iam.gserviceaccount.com',
    private_key: 'CHAVE-PRIVADA-DE-MENTIRA-QUE-NAO-PODE-VAZAR',
  };

  function arquivoDeCredencial(nome, conteudo) {
    const arquivo = path.join(pastaSemEnv, nome);
    fs.writeFileSync(arquivo, conteudo);
    return arquivo;
  }

  const CAMPOS = {
    FIREBASE_PROJECT_ID: 'projeto-exemplo',
    FIREBASE_CLIENT_EMAIL: 'conta@projeto-exemplo.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: 'chave-de-exemplo-nao-real',
  };

  test('em produção, sem credencial nenhuma, a API não sobe', () => {
    const r = carregarConfig({ NODE_ENV: 'production', DATABASE_URL: DIRETO });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/credencial do Firebase é obrigatória/);
  });

  test('em produção, com as três variáveis FIREBASE_*, sobe', () => {
    const r = carregarConfig({ NODE_ENV: 'production', DATABASE_URL: DIRETO, ...CAMPOS });

    expect(r.codigo).toBe(0);
  });

  test('em produção, com o caminho de um arquivo existente, sobe', () => {
    const arquivo = arquivoDeCredencial('credencial-de-exemplo.json', JSON.stringify(CHAVE_DE_EXEMPLO));

    const r = carregarConfig({
      NODE_ENV: 'production',
      DATABASE_URL: DIRETO,
      GOOGLE_APPLICATION_CREDENTIALS: arquivo,
    });

    expect(r.codigo).toBe(0);
  });

  test('caminho para arquivo inexistente é recusado já na subida', () => {
    const r = carregarConfig({
      NODE_ENV: 'development',
      DATABASE_URL: DIRETO,
      GOOGLE_APPLICATION_CREDENTIALS: path.join(pastaSemEnv, 'nao-existe.json'),
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/arquivo que não existe/);
  });

  test('arquivo que não é JSON válido é recusado na subida, sem ecoar o conteúdo', () => {
    // A corrupção precisa ser do tipo que faz o V8 citar o texto de origem:
    // valor sem aspas gera "Unexpected token 'C', ...\"ate_key\": CHAVE-PRIV\"...".
    // Um JSON apenas truncado gera "Unterminated string", sem trecho nenhum — e
    // com ele este teste passaria mesmo com o vazamento, sem medir nada. Isso
    // foi constatado reintroduzindo o defeito.
    const { private_key: _chave, ...semChave } = CHAVE_DE_EXEMPLO;
    const arquivo = arquivoDeCredencial(
      'corrompido.json',
      JSON.stringify(semChave).slice(0, -1) + ',"private_key": CHAVE-PRIVADA-DE-MENTIRA}'
    );

    const r = carregarConfig({
      NODE_ENV: 'development',
      DATABASE_URL: DIRETO,
      GOOGLE_APPLICATION_CREDENTIALS: arquivo,
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/não é um JSON válido/);
    // O V8 cita só uns dez caracteres ao redor do erro: procurar o texto inteiro
    // não detectaria o vazamento de um fragmento.
    expect(r.saida).not.toMatch(/CHAVE-PRIV/);
  });

  test('JSON sem os campos de uma conta de serviço é recusado, citando só os nomes', () => {
    const { private_key: _removida, ...semChave } = CHAVE_DE_EXEMPLO;
    const arquivo = arquivoDeCredencial('incompleto.json', JSON.stringify(semChave));

    const r = carregarConfig({
      NODE_ENV: 'development',
      DATABASE_URL: DIRETO,
      GOOGLE_APPLICATION_CREDENTIALS: arquivo,
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/Campos ausentes: private_key/);
    expect(r.saida).not.toMatch(/conta@projeto-exemplo/);
  });

  test('JSON de outro tipo de credencial é recusado', () => {
    const arquivo = arquivoDeCredencial(
      'outro-tipo.json',
      JSON.stringify({ ...CHAVE_DE_EXEMPLO, type: 'authorized_user' })
    );

    const r = carregarConfig({
      NODE_ENV: 'development',
      DATABASE_URL: DIRETO,
      GOOGLE_APPLICATION_CREDENTIALS: arquivo,
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/conta de serviço completa/);
  });

  test('com FIREBASE_* completas, um caminho de arquivo antigo não impede a subida', () => {
    // Situação típica de migração no painel do provedor: as variáveis novas
    // foram definidas e o caminho antigo ficou esquecido, apontando para nada.
    const r = carregarConfig({
      NODE_ENV: 'production',
      DATABASE_URL: DIRETO,
      ...CAMPOS,
      GOOGLE_APPLICATION_CREDENTIALS: path.join(pastaSemEnv, 'removido-ha-tempos.json'),
    });

    expect(r.codigo).toBe(0);
    expect(r.saida).toMatch(/ignorada/);
  });

  test('variáveis FIREBASE_* incompletas são recusadas', () => {
    const { FIREBASE_PRIVATE_KEY, ...semAChave } = CAMPOS;

    const r = carregarConfig({ NODE_ENV: 'development', DATABASE_URL: DIRETO, ...semAChave });

    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/incompleta/);
    expect(FIREBASE_PRIVATE_KEY).toBeDefined();
  });

  test('fora de produção, a credencial é opcional', () => {
    const r = carregarConfig({ NODE_ENV: 'development', DATABASE_URL: DIRETO });

    expect(r.codigo).toBe(0);
  });

  test('variáveis vazias, como no .env.example copiado, contam como ausentes', () => {
    const r = carregarConfig({
      NODE_ENV: 'development',
      DATABASE_URL: DIRETO,
      GOOGLE_APPLICATION_CREDENTIALS: '',
      FIREBASE_PROJECT_ID: '',
      FIREBASE_CLIENT_EMAIL: '',
      FIREBASE_PRIVATE_KEY: '',
    });

    expect(r.codigo).toBe(0);
  });

  test('a mensagem de erro nunca ecoa a chave privada', () => {
    const r = carregarConfig({
      NODE_ENV: 'development',
      DATABASE_URL: DIRETO,
      FIREBASE_PRIVATE_KEY: 'segredo-que-nao-pode-aparecer',
    });

    expect(r.codigo).toBe(1);
    expect(r.saida).not.toMatch(/segredo-que-nao-pode-aparecer/);
  });
});
