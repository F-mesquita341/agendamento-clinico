'use strict';

/**
 * A trava de sandbox no processo de verdade.
 *
 * `tests/unit/travaDeSandbox.test.js` prova a decisão; este prova que ela é
 * CHAMADA — que a API não abre a porta com uma credencial que não se confirmou
 * ser de conta de teste. Sem ele, apagar a verificação de `servidor.js` não
 * derrubaria nenhum teste, e a proteção existiria só no papel.
 *
 * Vale com ou sem rede: credencial recusada pelo provedor e provedor
 * inalcançável levam ao mesmo lugar, porque a trava falha fechada.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const RAIZ = path.join(__dirname, '..', '..');

/** Uma porta livre, para não esbarrar em outra coisa rodando na máquina. */
function portaLivre() {
  return new Promise((resolver, rejeitar) => {
    const servidor = net.createServer();
    servidor.once('error', rejeitar);
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address();
      servidor.close(() => resolver(port));
    });
  });
}

function subirApi(variaveis) {
  const processo = spawn(process.execPath, [path.join('src', 'servidor.js')], {
    cwd: RAIZ,
    env: { ...process.env, ...variaveis },
  });

  let saida = '';
  processo.stdout.on('data', (p) => {
    saida += p.toString();
  });
  processo.stderr.on('data', (p) => {
    saida += p.toString();
  });

  const terminou = new Promise((resolver) => {
    processo.once('exit', (codigo) => resolver({ codigo, saida }));
  });

  const prazo = setTimeout(() => processo.kill('SIGKILL'), 30_000);
  return terminou.finally(() => clearTimeout(prazo));
}

describe('trava de sandbox na subida', () => {
  test('credencial não confirmada como de teste impede a API de abrir a porta', async () => {
    // Uma porta livre de verdade: se a subida não fosse barrada, a API
    // conseguiria abri-la e o teste veria "ouvindo em" — que é justamente o
    // que não pode acontecer.
    const { codigo, saida } = await subirApi({
      PORTA: String(await portaLivre()),
      MERCADO_PAGO_ACCESS_TOKEN: 'APP_USR-0000000000000000-000000-credencial-invalida-0',
    });

    expect(saida).toMatch(/trava de sandbox/i);
    expect(saida).not.toMatch(/ouvindo em/);
    expect(codigo).toBe(1);
  }, 45_000);
});
