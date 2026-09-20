'use strict';

/**
 * Ponto de entrada da API — a raiz de composição.
 *
 * É aqui, e só aqui, que as dependências de produção são escolhidas e montadas.
 * Os testes não passam por este arquivo: montam o app com `criarApp` e um
 * verificador de token falso, e nunca ligam rotinas periódicas.
 */

const config = require('./config');
const { criarApp } = require('./interfaces/http/app');
const { criarVerificadorFirebase } = require('./infra/firebase/verificadorDeToken');
const { criarGatewayDePagamento } = require('./infra/pagamento');
const { RepositorioDeConsultasPg } = require('./infra/db/RepositorioDeConsultasPg');
const { RepositorioDePagamentosPg } = require('./infra/db/RepositorioDePagamentosPg');
const { ExpirarReservasVencidas } = require('./application/ExpirarReservasVencidas');
const { agendar } = require('./infra/agendador');
const { encerrar, transporte } = require('./infra/db/pool');

const INTERVALO_DA_EXPIRACAO_MS = 60_000;
const PRAZO_DO_DESLIGAMENTO_MS = 10_000;

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

const gateway = criarGatewayDePagamento();
if (!config.MERCADO_PAGO_ACCESS_TOKEN) {
  console.warn('Aviso: Mercado Pago não configurado. POST /consultas/:id/pagamento vai responder 503.');
} else if (!config.urlPublica) {
  // Com credencial e sem endereço público, o checkout é criado sem para onde
  // avisar: o pagamento acontece e a consulta fica aguardando até a
  // reconciliação alcançá-la. Melhor dizer isso na subida do que deixar
  // alguém diagnosticar "o pagamento não confirma".
  console.warn(
    'Aviso: sem URL_PUBLICA (nem RENDER_EXTERNAL_URL). Os checkouts serão criados sem\n' +
      'endereço de notificação: a confirmação dependerá da reconciliação, que roda a cada minuto.'
  );
}

const app = criarApp({ verificarToken, gateway });

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

// Reservas não pagas voltam à grade. Só roda enquanto a API está de pé — no
// plano gratuito do Render ela hiberna, e por isso a rotina também roda logo
// na subida.
const expirar = new ExpirarReservasVencidas({
  consultas: new RepositorioDeConsultasPg(),
  pagamentos: new RepositorioDePagamentosPg(),
  gateway,
});
const rotinaDeExpiracao = agendar(() => expirar.executar(), INTERVALO_DA_EXPIRACAO_MS, {
  nome: 'expiração de reservas',
  aoTerminar: ({ expiradas, confirmadas, adiadas, falhas }) => {
    if (expiradas || confirmadas || adiadas || falhas) {
      console.log(
        `Expiração de reservas: ${expiradas} expirada(s), ${confirmadas} confirmada(s) ` +
          `na reconciliação, ${adiadas} adiada(s), ${falhas} falha(s).`
      );
    }
  },
});

/**
 * Desligamento: o Render manda SIGTERM a cada publicação.
 *
 * Para a rotina, deixa as requisições em andamento terminarem, fecha o pool e
 * sai. Duas proteções que faltavam: o erro ao fechar o pool é tratado — antes
 * virava rejeição não tratada, e um encerramento normal aparecia como falha —,
 * e há prazo — uma conexão presa impedia o `close` de terminar, e o processo
 * acabava morto à força.
 */
let desligando = false;

function desligar(sinal) {
  if (desligando) return;
  desligando = true;
  console.log(`\n${sinal} recebido, encerrando...`);

  rotinaDeExpiracao.parar();

  const prazo = setTimeout(() => {
    console.error(`Encerramento passou de ${PRAZO_DO_DESLIGAMENTO_MS / 1000} s; saindo à força.`);
    process.exit(1);
  }, PRAZO_DO_DESLIGAMENTO_MS);
  prazo.unref();

  servidor.close(async () => {
    try {
      await encerrar();
      process.exitCode = 0;
    } catch (erro) {
      console.error('Falha ao fechar as conexões com o banco:', erro.message);
      process.exitCode = 1;
    } finally {
      clearTimeout(prazo);
      process.exit();
    }
  });
  // Conexões keep-alive ociosas não impedem mais o fechamento.
  servidor.closeIdleConnections();
}

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => desligar(sinal));
}
