'use strict';

/**
 * Prepara para uso a tabela de aparelhos que recebem notificação push.
 *
 * Ela já existia: a migration 003 criou `device_token` junto com a estrutura do
 * pagamento, prevendo a etapa das notificações, e nunca foi usada — nenhuma
 * linha de código a lê ou escreve. Esta migration a completa em vez de criar
 * outra tabela para a mesma coisa.
 *
 * Três mudanças:
 *
 * 1. **Renomeada para `dispositivo`.** Era a única tabela com nome em inglês no
 *    esquema — consulta, horario, paciente, pagamento, auditoria. Nome
 *    misturado em metade do esquema é o tipo de coisa que, num trabalho que vai
 *    ser lido por uma banca, cobra explicação que não tem resposta boa.
 *
 * 2. **`plataforma` ganha restrição.** Era texto livre com padrão 'android', o
 *    que aceitaria qualquer coisa. Agora só 'android', 'ios' ou 'web', e sem
 *    padrão: quem registra o aparelho sabe qual é, e adivinhar é pior do que
 *    perguntar.
 *
 * 3. **`atualizado_em`**, para registrar a reatribuição.
 *
 * O que já estava certo e permanece: `token` ÚNICO e `ON DELETE CASCADE` no
 * paciente. O UNIQUE é regra de privacidade, não arrumação — registrar um token
 * que pertence a outra conta REATRIBUI. Com duas linhas para o mesmo token, o
 * dono anterior continuaria recebendo, naquele aparelho, o lembrete das
 * consultas dele, e quem está com o telefone na mão veria que outra pessoa tem
 * consulta marcada: dado de saúde de terceiro em tela bloqueada.
 *
 * O token é identificador de aparelho, e portanto dado pessoal (LGPD, Art. 5º,
 * I). Não vai para log, não volta em resposta de API e não entra em auditoria —
 * lá fica só a contagem de aparelhos avisados.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE device_token RENAME TO dispositivo;

    ALTER TABLE dispositivo ALTER COLUMN plataforma DROP DEFAULT;
    ALTER TABLE dispositivo ADD CONSTRAINT dispositivo_plataforma_conhecida
      CHECK (plataforma IN ('android', 'ios', 'web'));

    ALTER TABLE dispositivo ADD COLUMN atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now();

    -- A busca da rotina de lembretes: todos os aparelhos de um paciente.
    CREATE INDEX idx_dispositivo_paciente ON dispositivo (paciente_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_dispositivo_paciente;
    ALTER TABLE dispositivo DROP COLUMN IF EXISTS atualizado_em;
    ALTER TABLE dispositivo DROP CONSTRAINT IF EXISTS dispositivo_plataforma_conhecida;
    ALTER TABLE dispositivo ALTER COLUMN plataforma SET DEFAULT 'android';
    ALTER TABLE dispositivo RENAME TO device_token;
  `);
};
