'use strict';

/**
 * Executor de migrations.
 *
 * Substitui o CLI do node-pg-migrate porque o CLI sempre abre a conexão com o
 * driver `pg`, em TCP na 5432 — e numa rede que bloqueia essa porta ele falha
 * mesmo com a aplicação funcionando por WebSocket. Usando a API programática,
 * passamos um cliente já criado pelo transporte escolhido em
 * src/infra/db/driver.js, e migration e aplicação seguem o mesmo caminho.
 *
 * Uso:
 *   node scripts/migrar.js            # aplica no banco de desenvolvimento
 *   node scripts/migrar.js --teste    # aplica no banco de teste
 *   node scripts/migrar.js --desfazer # desfaz a última no desenvolvimento
 */

const path = require('path');
const { runner } = require('node-pg-migrate');
const config = require('../src/config');
const { Client, transporte } = require('../src/infra/db/driver');

const argumentos = process.argv.slice(2);
const noBancoDeTeste = argumentos.includes('--teste');
const desfazer = argumentos.includes('--desfazer');

const url = noBancoDeTeste ? config.DATABASE_URL_TESTE : config.DATABASE_URL;

if (!url) {
  console.error(
    `\n${noBancoDeTeste ? 'DATABASE_URL_TESTE' : 'DATABASE_URL'} não está definida no .env\n`
  );
  process.exit(1);
}

async function migrar() {
  // Em produção este script roda na subida do serviço, antes de abrir a porta;
  // dizer "desenvolvimento" no log da publicação confundiria o diagnóstico.
  const rotulo = noBancoDeTeste
    ? 'teste'
    : config.NODE_ENV === 'production'
      ? 'PRODUÇÃO'
      : 'desenvolvimento';
  const direcao = desfazer ? 'down' : 'up';

  console.log(
    `Migrations (${direcao}) no banco de ${rotulo}, via ${transporte}...`
  );

  const cliente = new Client({ connectionString: url });
  await cliente.connect();

  try {
    const aplicadas = await runner({
      dbClient: cliente,
      dir: path.join(__dirname, '..', 'migrations'),
      migrationsTable: 'pgmigrations',
      direction: direcao,
      // 'up' aplica tudo que falta; 'down' desfaz só a última, para que um
      // comando distraído não derrube o schema inteiro.
      count: desfazer ? 1 : Infinity,
      verbose: false,
    });

    if (aplicadas.length === 0) {
      console.log('Nada a fazer — o banco já está atualizado.');
    } else {
      for (const m of aplicadas) console.log(`  ${direcao}  ${m.name}`);
      console.log(`${aplicadas.length} migration(s) aplicada(s).`);
    }
  } finally {
    await cliente.end();
  }
}

migrar().catch((erro) => {
  console.error('\nFalha na migration:', erro.message, '\n');
  process.exitCode = 1;
});
