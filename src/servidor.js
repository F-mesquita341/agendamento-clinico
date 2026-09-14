'use strict';

const app = require('./interfaces/http/app');
const config = require('./config');
const { encerrar } = require('./infra/db/pool');

const servidor = app.listen(config.PORTA, () => {
  console.log(
    `API de agendamento ouvindo em http://localhost:${config.PORTA} (${config.NODE_ENV})`
  );
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
