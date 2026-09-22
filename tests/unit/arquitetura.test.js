'use strict';

/**
 * A regra de dependência, verificada por máquina.
 *
 * Martin (2019) formula que as camadas internas não devem conhecer as externas.
 * Num trabalho acadêmico é fácil AFIRMAR isso no texto e violar no código sem
 * perceber — um `require` distraído de `pg` dentro de um caso de uso passa
 * despercebido numa revisão manual.
 *
 * Este teste lê os arquivos de `domain/` e `application/` e falha se algum
 * deles importar framework, driver de banco ou camada de borda. A partir daqui,
 * a afirmação do Capítulo 5 é auditável: basta rodar a suíte.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..', 'src');

const PACOTES_PROIBIDOS = [
  'express',
  'pg',
  'firebase-admin',
  'helmet',
  'cors',
  'dotenv',
  'supertest',
  'mercadopago',
];

const CAMADAS_DE_BORDA = ['infra', 'interfaces'];

function arquivosJs(diretorio) {
  if (!fs.existsSync(diretorio)) return [];
  return fs.readdirSync(diretorio, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) return arquivosJs(caminho);
    return entrada.name.endsWith('.js') ? [caminho] : [];
  });
}

function importacoesDe(caminho) {
  const conteudo = fs.readFileSync(caminho, 'utf8');
  // Ignora linhas de comentário para não pegar exemplos citados na documentação.
  const codigo = conteudo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [...codigo.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

describe('regra de dependência', () => {
  const internos = [
    ...arquivosJs(path.join(RAIZ, 'domain')),
    ...arquivosJs(path.join(RAIZ, 'application')),
  ];

  test('existem arquivos de domínio para verificar', () => {
    expect(internos.length).toBeGreaterThan(0);
  });

  test.each(internos.map((c) => [path.relative(RAIZ, c), c]))(
    '%s não importa framework nem driver de banco',
    (_rotulo, caminho) => {
      const proibidos = importacoesDe(caminho).filter((imp) =>
        PACOTES_PROIBIDOS.includes(imp.split('/')[0])
      );

      expect(proibidos).toEqual([]);
    }
  );

  test.each(internos.map((c) => [path.relative(RAIZ, c), c]))(
    '%s não alcança as camadas de borda',
    (_rotulo, caminho) => {
      const vazamentos = importacoesDe(caminho)
        .filter((imp) => imp.startsWith('.'))
        .map((imp) => path.relative(RAIZ, path.resolve(path.dirname(caminho), imp)))
        .filter((destino) =>
          CAMADAS_DE_BORDA.includes(destino.split(path.sep)[0])
        );

      expect(vazamentos).toEqual([]);
    }
  );

  test('o domínio não depende da camada de aplicação', () => {
    const doDominio = arquivosJs(path.join(RAIZ, 'domain'));

    for (const caminho of doDominio) {
      const alcanca = importacoesDe(caminho)
        .filter((imp) => imp.startsWith('.'))
        .map((imp) => path.relative(RAIZ, path.resolve(path.dirname(caminho), imp)))
        .filter((destino) => destino.split(path.sep)[0] === 'application');

      expect(alcanca).toEqual([]);
    }
  });
});

/**
 * Os dublês de teste cumprem o contrato inteiro — também verificado por máquina.
 *
 * Herdar da classe abstrata faz um método esquecido estourar com o nome dele
 * QUANDO chamado; este teste acusa a falta antes, mesmo que nenhum teste
 * chame o método. Foi assim que `ConsultasFalsas.leituraPorId` faltou sem que
 * ninguém percebesse: nenhum teste de unidade o chamava.
 */
describe('dublês de teste', () => {
  const contratos = require('../../src/domain/repositorios');
  const { GatewayDePagamento } = require('../../src/domain/pagamentos');
  const { ServicoDeNotificacao } = require('../../src/domain/notificacoes');
  const dubles = require('../helpers/repositoriosFalsos');
  const { GatewayFalso } = require('../helpers/gatewayFalso');
  const { NotificadorFalso } = require('../helpers/notificadorFalso');

  const pares = [
    [contratos.RepositorioDeHorarios, dubles.HorariosFalsos],
    [contratos.RepositorioDeConsultas, dubles.ConsultasFalsas],
    [contratos.RepositorioDePacientes, dubles.PacientesFalsos],
    [GatewayDePagamento, GatewayFalso],
    [ServicoDeNotificacao, NotificadorFalso],
  ];

  test.each(pares.map(([contrato, duble]) => [duble.name, contrato.name, contrato, duble]))(
    '%s implementa todos os métodos de %s',
    (_duble, _contrato, Contrato, Duble) => {
      const metodos = Object.getOwnPropertyNames(Contrato.prototype).filter(
        (nome) => nome !== 'constructor'
      );
      const faltando = metodos.filter(
        (nome) => !Object.prototype.hasOwnProperty.call(Duble.prototype, nome)
      );

      expect(Duble.prototype).toBeInstanceOf(Contrato);
      expect(faltando).toEqual([]);
    }
  );
});
