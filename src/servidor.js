'use strict';

/**
 * Ponto de entrada da API — a raiz de composição.
 *
 * É aqui, e só aqui, que as dependências de produção são escolhidas e montadas.
 * Os testes não passam por este arquivo: montam o app com `criarApp` e um
 * verificador de token falso.
 */

const config = require('./config');
const { criarApp } = require('./interfaces/http/app');
const { criarVerificadorFirebase } = require('./infra/firebase/verificadorDeToken');
const { encerrar, transporte } = require('./infra/db/pool');

const verificarToken = criarVerificadorFirebase();

// Carrega o Firebase Admin antes de abrir a porta, e não na primeira requisição
// autenticada. Ver o comentário em infra/firebase/verificadorDeToken.js.
if (config.credencialFirebase) {
  const inicio = Date.now();
  verificarToken.preparar();
  console.log(
    `Firebase Admin carregado em ${Date.now() - inicio} ms ` +
      `(projeto ${config.projetoFirebase}, credencial por ${config.credencialFirebase})`
  );
} else {
  // Só chega aqui fora de produção: em produção, config.js já recusou a subida.
  console.warn(
    'Aviso: sem credencial do Firebase. As rotas autenticadas vão responder erro\n' +
      'interno. Defina GOOGLE_APPLICATION_CREDENTIALS no .env.'
  );
}

const app = criarApp({ verificarToken });

const servidor = app.listen(config.PORTA, () => {
  console.log(
    `API de agendamento ouvindo em http://localhost:${config.PORTA} (${config.NODE_ENV})`
  );
  // Registrar o transporte poupa diagnóstico: uma lentidão inesperada costuma
  // ser o WebSocket ligado numa rede em que o TCP direto funcionaria.
  console.log(`Banco: PostgreSQL via ${transporte}`);
});

servidor.on('error', (erro) => {
  if (erro.code === 'EADDRINUSE') {
    console.error(
      `\nA porta ${config.PORTA} já está em uso — provavelmente a API já está rodando\n` +
        'em outro terminal. Use a que está aberta, ou encerre-a antes de subir outra.\n'
    );
    process.exit(1);
  }
  throw erro;
});

// O Render envia SIGTERM antes de derrubar o contêiner. Fechar o pool evita
// conexões penduradas no Neon, que tem limite no tier gratuito.
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    console.log(`\n${sinal} recebido, encerrando...`);
    servidor.close(async () => {
      await encerrar();
      process.exit(0);
    });
  });
}
