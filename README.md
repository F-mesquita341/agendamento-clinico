# API de Agendamento de Consultas Clínicas

API REST que intermedia o agendamento e o pagamento de consultas entre pacientes
e clínicas de pequeno e médio porte. É o back-end do aplicativo **Marcaí**.

Produto secundário do Trabalho de Conclusão de Curso **“Desenvolvimento de um
aplicativo móvel para gerenciamento e pagamento centralizado de consultas
clínicas”**, do curso de Sistemas de Informação do Centro Universitário Católica
de Quixadá.

- **Autor:** Felipe Mesquita Pinto
- **Orientador:** Décio Gonçalves de Aguiar Neto

> Este repositório é público para permitir replicabilidade e auditoria por
> terceiros, conforme declarado na metodologia do projeto de pesquisa.
> A integração de pagamento opera **exclusivamente em ambiente sandbox**:
> nenhuma transação financeira real é processada.

## Versões

| Versão | Branch | Ambiente | O que tem |
|---|---|---|---|
| v1 | `main` | produção | Agendamento com lock otimista, pagamento antecipado em sandbox, lembrete, LGPD |
| v2 | `versao-2` | homologação | A v1 mais cidades, planos de saúde, pagar pelo plano ou na clínica, próximo horário e, desligado por padrão, Pix em sandbox ([Versão 2](#versão-2)) |

As sessões com participantes usaram o aplicativo **2.0.1** contra a
homologação, sem Pix. O Pix aparece a partir do aplicativo 2.1.0.

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 24 |
| HTTP | Express |
| Banco | PostgreSQL (Neon) |
| Validação | Zod |
| Migrations | node-pg-migrate |
| Autenticação | Firebase Authentication (Admin SDK) |
| Notificações | Firebase Cloud Messaging |
| Pagamento | Mercado Pago (sandbox) |
| Testes | Jest e Supertest |
| CI | GitHub Actions |
| Hospedagem | Render |

## Arquitetura

Camadas organizadas segundo a regra de dependência da Arquitetura Limpa: o que
está dentro não conhece o que está fora.

```
src/
  domain/        entidades e regras puras — não importa Express, pg nem Firebase
  application/   casos de uso
  infra/         PostgreSQL, Firebase, Mercado Pago
  interfaces/    rotas HTTP, controllers, middlewares
```

Um teste de arquitetura lê `domain/` e `application/` e falha se algum arquivo
importar framework, banco ou provedor.

## Convenções da API

Recursos são substantivos no plural, os verbos HTTP carregam a semântica da
operação e todo erro sai no mesmo envelope:

```json
{
  "erro": {
    "codigo": "HORARIO_INDISPONIVEL",
    "mensagem": "Este horário acabou de ser reservado por outro paciente.",
    "acao": "recarregar_horarios"
  }
}
```

O campo `acao` diz ao aplicativo o que fazer em seguida, sem que ele precise
interpretar o texto da mensagem.

| Código | Significado |
|---|---|
| 200 / 201 / 204 | Sucesso, criado, sem conteúdo |
| 400 | Requisição malformada |
| 401 | Token ausente, expirado ou inválido |
| 404 | Não existe — ou pertence a outro paciente, sem distinção |
| 409 | Conflito de concorrência ou de estado |
| 422 | Regra de negócio violada |
| 429 | Escritas demais em pouco tempo |
| 500 | Erro interno |

### Limite de escritas

Cada paciente tem até 30 escritas por minuto (`LIMITE_ESCRITAS_POR_MINUTO`).
Passando disso, a API responde **429** `MUITAS_REQUISICOES`, com a ação
`tentar_novamente` e o cabeçalho `Retry-After`.

- **A chave é o paciente, não o IP.** Celulares atrás do NAT da operadora
  dividem o mesmo endereço, e um limite por IP puniria um desconhecido pelo
  outro.
- **O orçamento é um só**, somado entre todas as rotas de escrita, e **pedido
  recusado também conta**: senão, bastaria mandar pedidos inválidos para
  escrever à vontade.
- **Fora do limite:** as leituras, `/saude` e o webhook do Mercado Pago, que a
  assinatura já protege.
- **Limitação conhecida:** as leituras públicas (catálogo e grade) não têm
  limite. Limitá-las exigiria chavear por IP.

A contagem fica na memória do processo. Com uma instância só, como hoje no
Render, basta.

### Cache

| Resposta | `Cache-Control` | Por quê |
|---|---|---|
| `GET /especialidades` | `public, max-age=3600` | Lista fechada, quase nunca muda |
| `GET /profissionais` e `/profissionais/:id` | `public, max-age=300` | Muda pouco, mas um profissional desativado não deve aparecer por muito tempo |
| `GET /profissionais/:id/horarios` | `no-store` | Uma grade velha mostraria como livre o horário que outra pessoa acabou de reservar |
| Perfil, consultas, aparelhos | `no-store` | Dado pessoal — consulta marcada é dado de saúde |
| `GET /consentimento/termo-vigente` | `no-store` | A troca de versão vale já no pedido seguinte |

### Clínica do profissional

Todo profissional sai com a clínica onde atende, em `GET /profissionais`,
`GET /profissionais/:id`, `GET /consultas` e `GET /consultas/:id`:

```json
"clinica": { "id": 1, "nome": "Clínica Exemplo Quixadá", "telefone": "(88) 3000-0000", "endereco": "Centro, Quixadá - CE" }
```

`telefone` e `endereco` podem vir `null`; a chave existe sempre. O CNPJ não
sai: o apresentador devolve uma lista fechada de campos.

## Controle de concorrência

Duas pessoas podem tentar o mesmo horário no mesmo instante. O agendamento usa
**lock otimista**: cada horário carrega uma coluna `versao`, devolvida ao
aplicativo na listagem e reenviada no momento de agendar.

```sql
UPDATE horario
   SET status = 'reservado', versao = versao + 1
 WHERE id = $1 AND versao = $2 AND status = 'disponivel';
```

Se nenhuma linha for afetada, outra pessoa chegou primeiro: a transação é
desfeita e a API responde **409** com a instrução de recarregar a grade.

Há ainda duas defesas no próprio banco, porque toda regra que compara estado
antes de gravar tem uma janela em que dois pedidos passam juntos:

- o índice único parcial `consulta_horario_ativo` impede duas consultas ativas
  no mesmo **horário**;
- a restrição de exclusão `consulta_sem_sobreposicao` impede duas consultas
  ativas sobrepostas na agenda do mesmo **paciente**, caso que o lock otimista
  não cobre.

As duas ignoram consultas canceladas, porque um horário cancelado precisa
voltar a ser agendável, enquanto o registro do cancelamento fica no histórico.

## Agendamento

| Rota | O que faz |
|---|---|
| `POST /consultas` | Agenda, com `{ horarioId, versao }` lidos da grade |
| `GET /consultas` | Lista as consultas do paciente do token, paginadas |
| `GET /consultas/:id` | Detalhe de uma consulta própria |
| `PATCH /consultas/:id/cancelamento` | Cancela e devolve o horário à grade |

A consulta nasce em `pendente_pagamento`, com o valor do profissional congelado
no ato e uma reserva de 15 minutos (`RESERVA_MINUTOS`).

Cancelar **não apaga** a consulta: ela muda para `cancelada` e continua no
histórico, que é a matéria-prima da análise de absenteísmo. O horário volta
para `disponivel` com a versão incrementada.

Cancelar pelo aplicativo tem dois limites de tempo:

- **Consulta paga que já começou não se cancela.** Senão, uma falta viraria
  "cancelada pelo paciente" nos dados da pesquisa. O caminho é falar com a
  clínica.
- **Reserva vencida também não.** Ela está com a rotina de expiração, que
  pergunta ao Mercado Pago antes de devolver o horário.

| Código | Ação indicada | Quando |
|---|---|---|
| `HORARIO_INDISPONIVEL` (409) | `recarregar_horarios` | Outra pessoa reservou o horário primeiro |
| `CONSULTA_SOBREPOSTA` (422) | — | O paciente já tem consulta ativa no mesmo intervalo |
| `HORARIO_NO_PASSADO` (422) | — | O horário já começou |
| `PROFISSIONAL_INDISPONIVEL` (422) | — | O profissional foi desativado |
| `CONSULTA_JA_CANCELADA` (422) | — | Cancelamento repetido |
| `CONSULTA_JA_INICIADA` (422) | — | Cancelar consulta paga cujo horário já começou |
| `RESERVA_EXPIRADA` (422) | — | Cancelar (ou pagar) reserva cujo prazo passou |
| `NAO_ENCONTRADO` (404) | — | A consulta não existe **ou pertence a outro paciente** |

Consulta de outro paciente responde exatamente como consulta inexistente: um
403 permitiria a qualquer paciente autenticado contar os registros da clínica
percorrendo ids.

Na grade, `?de=` e `?ate=` aceitam instante ISO 8601 ou data sem hora, lida
como meia-noite no fuso da clínica (`America/Fortaleza`).

## Pagamento (sandbox)

O pagamento é **simulado** pelo Mercado Pago em sandbox, com Checkout Pro: o
paciente paga numa página do Mercado Pago, e nenhum dado de cartão passa pela
API nem pelo aplicativo.

| Rota | Acesso | O que faz |
|---|---|---|
| `POST /consultas/:id/pagamento` | token + dono | Abre o checkout — ou devolve o que já está aberto |
| `POST /webhooks/mercadopago` | pública, assinada | Recebe o aviso de que um pagamento mudou |

1. O app pede o pagamento e recebe `checkoutUrl`, com o mesmo prazo da reserva.
2. O paciente paga na página do Mercado Pago.
3. O Mercado Pago avisa a API pelo webhook. A API **confere a assinatura**, busca
   o pagamento **no próprio Mercado Pago** — o conteúdo do aviso não é usado —,
   confere valor e moeda, e confirma a consulta.
4. O app acompanha por `GET /consultas/:id` até ver `confirmada`.

Reservas não pagas expiram: uma rotina, a cada minuto, cancela a consulta
vencida com `motivoCancelamento: "reserva_expirada"` e devolve o horário à
grade. Antes, ela pergunta ao Mercado Pago se houve pagamento cujo aviso se
perdeu — e, se houve, confirma em vez de expirar.

**Trava de sandbox:** a API **não sobe** com credencial de conta real. Na
subida, ela pergunta ao Mercado Pago de quem é a credencial (`GET /users/me`) e
só abre a porta se a conta for de teste. Se o provedor não responder, também
não sobe. O banco ainda só aceita `ambiente = 'sandbox'` na tabela de
pagamentos.

O que vai ao Mercado Pago é o mínimo: o item "Consulta médica", o valor, uma
referência aleatória e o prazo. Nada do paciente. Cancelar uma consulta já paga
não estorna nada (estorno automático está fora do escopo), mas registra em
auditoria que há estorno a fazer.

| Código | Quando |
|---|---|
| `CONSULTA_NAO_PAGAVEL` (422) | A consulta já está paga ou foi cancelada |
| `RESERVA_EXPIRADA` (422) | O prazo para pagar terminou |
| `PAGAMENTO_INDISPONIVEL` (503, `tentar_novamente`) | O Mercado Pago não respondeu, ou não está configurado |
| `ASSINATURA_INVALIDA` (401) | Aviso sem assinatura válida no webhook |

## Lembrete de consulta

O projeto aponta o lembrete automatizado entre as intervenções de maior
efetividade documentada contra o absenteísmo, ao lado do pagamento prévio. O
trabalho incorpora as duas.

| Rota | Acesso | O que faz |
|---|---|---|
| `POST /dispositivos` | token | Registra o aparelho — `{ token, plataforma }` → 201 `{ dispositivo: { id } }` |
| `DELETE /dispositivos/:id` | token + dono | Revoga o aparelho, 204; aparelho alheio ou inexistente, 404 |

Uma rotina, a cada 15 minutos, avisa pelo Firebase Cloud Messaging quem tem
consulta **confirmada** nas próximas 24 horas.

- **A marca de enviado é gravada antes do envio.** Uma queda no meio perde o
  lembrete em vez de mandá-lo duas vezes, que é o erro menos grave. Se o
  provedor recusar, a marca é desfeita e a rodada seguinte tenta.
- **A mensagem expira no começo da consulta**, para não chegar depois dela
  dizendo "amanhã".
- **O texto não revela dado de saúde:** "Você tem uma consulta amanhã às
  14:30", sem especialidade nem profissional, porque aparece em tela bloqueada
  (LGPD, Art. 11).
- **Um aparelho que troca de conta é reatribuído**, e não duplicado, para o
  dono anterior não receber o lembrete do outro.
- **O aparelho é revogado pelo id**, e não pelo token, que identifica o
  telefone e ficaria registrado em logs de acesso.

**Limitação do plano gratuito:** a rotina só roda com a API acordada, e no
Render ela hiberna depois de 15 minutos parada. Um lembrete pode sair atrasado,
ou não sair.

## Autenticação

A identidade é do Firebase Authentication. O aplicativo faz login no Firebase e
envia o ID Token em cada requisição protegida (`Authorization: Bearer
<id-token>`). A API verifica o token com o Admin SDK. **Uid e e-mail vêm sempre
do token verificado**, nunca do corpo da requisição.

| Rota | O que faz |
|---|---|
| `POST /pacientes` | Cadastra o perfil da conta autenticada |
| `GET /pacientes/me` | Lê o próprio perfil |
| `PATCH /pacientes/me` | Atualiza nome, telefone ou data de nascimento |

Não há rota que receba id de paciente: `/me` é resolvido pelo token.

| Código | Ação indicada | Quando |
|---|---|---|
| `NAO_AUTENTICADO` (401) | `autenticar` | Token ausente ou inválido |
| `SESSAO_EXPIRADA` (401) | `renovar_token` | Token expirou — renovar e repetir, sem voltar ao login |
| `PERFIL_NAO_CADASTRADO` (404) | `completar_cadastro` | Conta autenticada ainda sem cadastro |
| `CONSENTIMENTO_OBRIGATORIO` (422) | `exibir_termo` | Cadastro sem aceite da versão vigente do termo |

### Consentimento (LGPD)

O cadastro exige `consentimento: { aceito: true, versao }` com a versão vigente
do [termo](docs/termo-de-consentimento.md). A API grava a versão aceita e o
instante do aceite pelo relógio do servidor, e o banco recusa paciente sem esses
dois campos. Cadastros e atualizações geram linha em `auditoria`, com os nomes
dos campos alterados e nunca os valores.

A versão vigente vem de `GET /consentimento/termo-vigente` (`{ "termo": {
"versao": "2026-09-v2" } }`). O aplicativo não embute a versão, e **o aceite
precisa ser do texto que a pessoa leu**: se a versão vigente não for a do texto
que o aplicativo tem, ele pede para ser atualizado em vez de enviar o aceite.

## Publicação

A API roda no Render, descrita por [`render.yaml`](render.yaml); só os segredos
ficam no painel. O banco fica no Neon e a autenticação no Firebase. As
migrations rodam antes de a porta abrir (`npm run migrate && npm start`), para
uma publicação com migration pendente não subir pela metade.

**CORS.** Em produção, `ORIGENS_PERMITIDAS` não pode ser `*`: a API se recusa a
subir. O aplicativo Android e o webhook do Mercado Pago não são navegadores e
não passam por CORS.

**Limitações do plano gratuito:**

- o serviço hiberna depois de 15 minutos parado, e a primeira requisição depois
  disso leva perto de um minuto;
- as rotinas de expiração e de lembrete só rodam com a API acordada;
- não há região no Brasil: cada ida ao banco custa cerca de 115 ms, contra
  56 ms de uma máquina local em Quixadá.

## Testes e verificação

- **Suíte automatizada** (Jest e Supertest), contra um banco de teste próprio,
  com um verificador de token falso que tem o mesmo contrato do real. Roda na
  integração contínua a cada envio.
- **Cada mecanismo relevante foi confirmado reintroduzindo o defeito:** o teste
  só conta se falhar sem a proteção que diz proteger.
- **Contra os serviços reais:** scripts provam a autenticação com tokens do
  Firebase, a credencial e o pagamento no sandbox do Mercado Pago e o fluxo
  publicado de ponta a ponta, sem nunca imprimir token, senha ou chave.

| Comando | O que faz |
|---|---|
| `npm test` | Suíte completa |
| `npm run test:unit` | Só os testes de unidade, sem banco |
| `npm run carga` | Teste de concorrência, com relatório (abaixo) |
| `npm run verificar:token` | Autenticação com tokens reais do Firebase |
| `npm run verificar:sandbox` | Credencial do Mercado Pago: conta de teste, checkout e pagamento |
| `npm run verificar:pix` | Versão 2: um Pix de teste de R$ 1,00 contra o sandbox real |
| `npm run verificar:portao` | Agenda, paga em sandbox e confere a confirmação pelo webhook, contra a API publicada |
| `npm run exportar:pesquisa` | Conjunto de dados da pesquisa, pseudonimizado (abaixo) |
| `npm run auditar:historico` | Procura credenciais em todo o histórico do Git (abaixo) |

### Teste de concorrência

O critério objetivo do projeto é **zero conflitos** com cem requisições
simultâneas para o mesmo horário. São três fases de 10 rodadas, cada rodada com
cem pacientes diferentes:

| Fase | O que faz | O que prova |
|---|---|---|
| A | Cem `POST /consultas` pelo mesmo horário, pela API completa | Não há duplicidade na prática |
| B | Cem chamadas direto ao adaptador, sem a checagem prévia | As recusas são do `UPDATE` condicional, e não do índice único |
| C | O horário é reservado e cancelado (versão 2); cem pedidos chegam com a versão 0 | Só a condição de versão recusa — o papel próprio do lock otimista |

A fase B distingue o `UPDATE` do índice pela sequência de ids de `consulta`:
toda tentativa de `INSERT` consome um número, mesmo quando é desfeita, então uma
rodada correta avança a sequência em exatamente um.

Os relatórios ficam em [`docs/resultados/concorrencia/`](docs/resultados/concorrencia/),
com data, commit, ambiente e as latências brutas. **Conflito** é agendamento
duplicado; **recusa** é o 409 de quem perdeu a disputa, e 99 por rodada é o
resultado correto. O teste roda com o limite de escritas num valor que não
dispara, que é o pior caso para o lock.

### Exportação para a pesquisa

A exportação tira do banco só o que a análise precisa, com paciente e consulta
trocados por pseudônimos: um HMAC-SHA256 do id com um segredo que nunca vai
para o Git (a "informação adicional mantida separadamente" da LGPD, Art. 13).

| Arquivo | Colunas |
|---|---|
| `consultas.csv` | `consulta`, `paciente`, `status`, `motivo_cancelamento`, `inicio`, `criada_em`, `paga`, `lembrete_enviado_em` |
| `eventos.csv` | `paciente`, `consulta`, `ator`, `acao`, `instante` — toda a auditoria, sem o campo `detalhe` |

**Não saem:** nome, e-mail, telefone, data de nascimento, uid do Firebase,
token de aparelho, profissional, especialidade (dado sensível, LGPD Art. 11),
valor e identificadores do Mercado Pago. As colunas são uma lista fechada no
código. A exportação recusa gravar dentro do repositório, nunca sobrescreve uma
anterior e confere que dois ids não deram o mesmo pseudônimo.

**Pseudonimizado não é anônimo:** enquanto o banco existir, uma linha exportada
pode ser casada com a dele. Até o fim da pesquisa, o conjunto continua sendo
dado pessoal.

### Credenciais fora do histórico

O repositório é público, e credencial que entra num commit continua no
histórico mesmo depois de apagada. O `auditar:historico` lê cada linha
acrescentada em cada commit, de todas as referências, e procura `.env`
versionado, chave privada, JSON de conta de serviço, token do Mercado Pago, URL
do PostgreSQL com senha e outros segredos. Relata commit, arquivo, linha e tipo
— **nunca o valor** — e roda na integração contínua a cada envio.

Se acusar algo, o que resolve é **trocar a credencial**: reescrever o histórico
não desfaz uma exposição que já foi publicada. Falsos positivos revisados ficam
em [`scripts/excecoes-da-auditoria.js`](scripts/excecoes-da-auditoria.js), com
o motivo.

## Versão 2

A versão 2 ("iFood mínimo") vive na homologação, que publica a branch
`versao-2` (`https://agendamento-clinico-homolog.onrender.com`), com banco
próprio. A produção não recebe nada dela. Tudo é aditivo: nenhum campo da v1
mudou.

### Cidade, planos, formas de pagamento e próximo horário

| Rota | O que faz |
|---|---|
| `GET /cidades` | `{ cidades: [{ id, nome, uf }] }`: só as cidades com profissional ativo. Cache de 5 minutos |
| `GET /planos` | `{ planos: [{ id, nome }] }`: só os planos aceitos por profissional ativo. Cache de 5 minutos |
| `GET /profissionais?cidade=&plano=` | Filtros novos, opcionais e combináveis com `especialidade` e `q` |

Cada profissional do catálogo ganha:

- `clinica.cidade`, `clinica.latitude` e `clinica.longitude` (ou `null`). A
  distância é calculada no aparelho; a localização do paciente não chega à API;
- `planos`: `[{ id, nome }]`, ou `[]`;
- `formasDePagamento`: na ordem `app`, `plano`, `clinica`, **nunca vazia**;
- `proximoHorario`: `{ id, inicio }` do horário livre mais cedo, ou `null`.
  É indicativo, por causa do cache; para agendar, vale a grade.

Planos e próximo horário saem de subconsultas `LATERAL`, e o filtro por plano é
um `EXISTS`: um `JOIN` repetiria o profissional uma vez por plano e inflaria o
total da paginação.

### Pagar com o plano ou na clínica

O `POST /consultas` aceita, opcionais, `formaDePagamento` (`app`, `plano` ou
`clinica`) e `planoId` (só, e sempre, com `plano`).

| Forma | Consulta criada |
|---|---|
| `app` (ou ausente) | `pendente_pagamento`, com reserva de 15 minutos e checkout depois |
| `plano` ou `clinica`, aceitos pelo profissional | `confirmada`, sem prazo e sem checkout. A clínica confere o plano no dia |

Forma ou plano que o profissional não aceita respondem 422
`FORMA_DE_PAGAMENTO_NAO_ACEITA` ou `PLANO_NAO_ACEITO`. A conferência acontece
**dentro da transação da reserva**, depois do lock otimista, e a recusa desfaz
a reserva. Toda consulta da v2 traz `formaDePagamento` e `plano`. O banco guarda
a regra em três restrições: plano escolhido se, e somente se, a forma é plano;
só o app fica `pendente_pagamento`; só o app tem prazo de reserva.

### Pagar com Pix (sandbox), desligado por padrão

As rotas só existem com `PIX_HABILITADO=true`. Desligada a chave, elas nem são
montadas, e a API responde exatamente como antes.

| Rota | O que faz |
|---|---|
| `POST /consultas/:id/pagamento/pix` | 201 com `{ pix: { copiaECola, qrCodeBase64, expiraEm, valorCentavos, valorFormatado } }` quando cria; 200 com o **mesmo** Pix quando já existe um aberto |
| `POST /consultas/:id/pagamento/pix/conferir` | 200 com `{ consulta }`: pergunta ao Mercado Pago se o Pix foi pago e, se foi, confirma pelo mesmo caminho do webhook. O app chama a cada 5 segundos enquanto espera |

- **As regras do checkout valem iguais:** só a consulta do próprio paciente,
  pelo aplicativo, aguardando pagamento e dentro do prazo.
- **Um pagamento aberto por consulta, de qualquer meio.** Com a página do
  Mercado Pago aberta, o Pix é recusado, e vice-versa: 409
  `PAGAMENTO_EM_ANDAMENTO`.
- **Quem decide confirmar continua sendo o domínio:** estado, valor e moeda
  conferidos, sob bloqueio.
- **A reconciliação da expiração não mudou:** ela já enxerga o pagamento do
  Pix, então um Pix pago no último instante confirma em vez de cancelar.
- **Nenhum dado do paciente vai ao Mercado Pago.** O pedido (API de Orders,
  Checkout Transparente) leva a referência aleatória, o valor, o prazo e um
  pagador fictício fixo, que no sandbox se aprova sozinho em segundos.
- **Banco:** a migration 012 só acrescenta colunas à tabela `pagamento`. Por
  isso há caminho de volta: desligar a chave, voltar o deploy ou desfazer a
  migration.

### Dados de demonstração

Só na homologação, `seed:demonstracao` e `seed:exemplos` criam um catálogo
fictício (três cidades do Ceará, sete clínicas, 20 profissionais) e um
histórico de consultas de 10 pacientes que não existem no Firebase. Os dois se
recusam a rodar em banco de produção. **Os números são inventados:** servem
para a demonstração e não são resultado da pesquisa.

## Licença

MIT.
