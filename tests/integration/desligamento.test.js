'use strict';

/**
 * O desligamento da API, com o processo de verdade.
 *
 * O Render manda SIGTERM a cada publicação. Até a Etapa 8, o tratador tinha
 * dois defeitos: a falha ao fechar o pool virava rejeição não tratada — um
 * encerramento normal aparecia como queda no log da plataforma — e não havia
 * prazo, então uma conexão presa impedia o processo de terminar.
 *
 * Só dá para verificar isso subindo o processo e mandando o sinal. O Windows
 * não tem sinais POSIX: `process.kill(pid, 'SIGTERM')` lá encerra o processo à
 * força, sem passar pelo tratador. O teste então roda no Linux — que é o
 * sistema da integração contínua e o do Render, onde o comportamento importa.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const noWindows = process.platform === 'win32';
const descreverForaDoWindows = noWindows ? describe.skip : describe;

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

function subirApi(porta) {
  const processo = spawn(process.execPath, [path.join('src', 'servidor.js')], {
    cwd: RAIZ,
    env: { ...process.env, PORTA: String(porta) },
  });

  let saida = '';
  processo.stdout.on('data', (pedaco) => {
    saida += pedaco.toString();
  });
  processo.stderr.on('data', (pedaco) => {
    saida += pedaco.toString();
  });

  const ouvindo = new Promise((resolver, rejeitar) => {
    const prazo = setTimeout(() => rejeitar(new Error(`A API não subiu. Saída:\n${saida}`)), 25_000);
    const conferir = setInterval(() => {
      if (saida.includes('ouvindo em')) {
        clearInterval(conferir);
        clearTimeout(prazo);
        resolver();
      }
    }, 50);
    processo.once('exit', (codigo) => {
      clearInterval(conferir);
      clearTimeout(prazo);
      rejeitar(new Error(`A API saiu antes de subir (código ${codigo}). Saída:\n${saida}`));
    });
  });

  return { processo, ouvindo, lerSaida: () => saida };
}

descreverForaDoWindows('desligamento com SIGTERM', () => {
  test('encerra sozinho, com código 0 e sem rejeição não tratada', async () => {
    const porta = await portaLivre();
    const { processo, ouvindo, lerSaida } = subirApi(porta);
    await ouvindo;

    const encerrou = new Promise((resolver) => processo.once('exit', (codigo) => resolver(codigo)));
    processo.kill('SIGTERM');

    const codigo = await Promise.race([
      encerrou,
      new Promise((_, rejeitar) =>
        setTimeout(() => {
          processo.kill('SIGKILL');
          rejeitar(new Error(`Não encerrou em 15 s. Saída:\n${lerSaida()}`));
        }, 15_000)
      ),
    ]);

    expect(codigo).toBe(0);
    const saida = lerSaida();
    expect(saida).toMatch(/SIGTERM recebido/);
    // Rejeição não tratada derrubaria o processo com stack trace e código
    // diferente de zero — era exatamente o defeito corrigido nesta etapa.
    expect(saida).not.toMatch(/UnhandledPromiseRejection|Unhandled 'error'/);
  }, 45_000);
});
