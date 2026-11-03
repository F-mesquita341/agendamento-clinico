'use strict';

/**
 * O migrador diz em que banco vai mexer — host e nome, nunca usuário nem
 * senha. É o que permite conferir, ao preparar o banco de produção pelo próprio
 * terminal, que a migration foi para o banco certo.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');
const config = require('../../src/config');
const { descreverBanco } = require('../../scripts/descreverBanco');

const MIGRAR = path.resolve(__dirname, '../../scripts/migrar.js');

function rodarMigrar(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [MIGRAR, ...args],
      { env: { ...process.env, NODE_ENV: 'test' }, timeout: 120_000 },
      (erro, stdout, stderr) => resolve({ codigo: erro ? erro.code : 0, stdout, stderr })
    );
  });
}

test('mostra o host e o nome do banco, sem a senha', async () => {
  const r = await rodarMigrar(['--teste']);

  expect(r.codigo).toBe(0);
  expect(r.stdout).toContain(`(${descreverBanco(config.DATABASE_URL_TESTE)})`);
  // A senha da URL não pode aparecer em lugar nenhum da saída.
  const senha = decodeURIComponent(new URL(config.DATABASE_URL_TESTE).password);
  if (senha) expect(r.stdout + r.stderr).not.toContain(senha);
  expect(r.stdout).not.toMatch(/postgres(ql)?:\/\//);
}, 120_000);
