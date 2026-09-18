# API de Agendamento de Consultas Clínicas

API REST que intermedia o agendamento e o pagamento de consultas entre pacientes
e clínicas de pequeno e médio porte.

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

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 22+ |
| HTTP | Express |
| Banco | PostgreSQL (Neon) |
| Validação | Zod |
| Migrations | node-pg-migrate |
| Autenticação | Firebase Authentication (Admin SDK) |
| Testes | Jest e Supertest |
| CI | GitHub Actions |

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

Se um arquivo de `domain/` precisar de um `require` de framework, a regra foi
quebrada em algum lugar.

## Como rodar

Pré-requisitos: Node.js 22 ou superior e uma conta no [Neon](https://neon.tech)
(tier gratuito).

```bash
git clone <url-deste-repositorio>
cd agendamento-clinico
npm install
```

Crie **dois bancos** no mesmo projeto do Neon — um de desenvolvimento e um de
teste. A suíte automatizada limpa tabelas, e você não quer que ela apague os
dados que usou para testar na mão.

```bash
cp .env.example .env    # no PowerShell: copy .env.example .env
```

Preencha `DATABASE_URL` e `DATABASE_URL_TESTE` no `.env`. Depois:

```bash
npm run migrate         # cria o schema no banco de desenvolvimento
npm run migrate:teste   # cria o mesmo schema no banco de teste
npm run seed            # popula especialidades, profissionais e agenda
npm run dev             # sobe em http://localhost:3000
```

Confirme com:

```bash
curl http://localhost:3000/saude
```

Resposta esperada:

```json
{ "status": "ok", "banco": "conectado", "latencia_ms": 42 }
```

### Se a conexão der timeout

Algumas redes gerenciadas — faculdades, empresas, certos provedores — liberam
apenas as portas 80 e 443 e barram a 5432, que é a do PostgreSQL. O sintoma é
`ETIMEDOUT` ao conectar, mesmo com a internet funcionando normalmente.

Para confirmar, verifique se o mesmo host responde na 443 e não na 5432. Se for
o caso, troque o transporte no `.env`:

```
TRANSPORTE_BANCO=websocket
```

O Neon passa a ser acessado por um driver que fala o protocolo do PostgreSQL
sobre WebSocket, na porta 443. O banco continua sendo PostgreSQL, o SQL é o
mesmo e as transações — das quais o lock otimista depende — funcionam
normalmente. Muda só o transporte.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe a API com recarga automática |
| `npm start` | Sobe a API |
| `npm run migrate` | Aplica migrations no banco de desenvolvimento |
| `npm run migrate:teste` | Aplica migrations no banco de teste |
| `npm run seed` | Popula dados de trabalho (idempotente) |
| `npm test` | Roda a suíte completa |
| `npm run test:unit` | Só os testes de unidade, sem banco |
| `npm run verificar:token` | Prova a autenticação com tokens reais do Firebase (ver abaixo) |

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
| 500 | Erro interno |

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
  no mesmo **horário**, mesmo que algum caminho futuro esqueça de comparar a
  versão;
- a restrição de exclusão `consulta_sem_sobreposicao` impede duas consultas
  ativas sobrepostas na agenda do mesmo **paciente**. O lock otimista não cobre
  esse caso: dois pedidos simultâneos para horários diferentes reservam linhas
  diferentes, sem nada em comum para disputar.

As duas são *parciais* — ignoram consultas canceladas — porque um horário
cancelado precisa voltar a ser agendável, enquanto o registro do cancelamento
permanece para o histórico.

## Agendamento

| Rota | O que faz |
|---|---|
| `POST /consultas` | Agenda, com `{ horarioId, versao }` lidos da grade |
| `GET /consultas` | Lista as consultas do paciente do token, paginadas |
| `GET /consultas/:id` | Detalhe de uma consulta própria |
| `PATCH /consultas/:id/cancelamento` | Cancela e devolve o horário à grade |

O fluxo do aplicativo é: ler a grade em `GET /profissionais/:id/horarios`,
guardar a `versao` de cada horário e reenviá-la ao agendar. A consulta nasce em
`pendente_pagamento`, com o valor do profissional congelado no ato e uma reserva
válida por `RESERVA_MINUTOS` (15 por padrão).

Cancelar **não apaga** a consulta: ela muda para `cancelada` e continua no
histórico, que é a matéria-prima da análise de absenteísmo. O horário volta para
`disponivel` com a versão incrementada de novo — quem ainda tiver a versão
anterior em mãos precisa recarregar a grade.

| Código | Ação indicada | Quando |
|---|---|---|
| `HORARIO_INDISPONIVEL` (409) | `recarregar_horarios` | Outra pessoa reservou o horário primeiro |
| `CONSULTA_SOBREPOSTA` (422) | — | O paciente já tem consulta ativa no mesmo intervalo |
| `HORARIO_NO_PASSADO` (422) | — | O horário já começou |
| `PROFISSIONAL_INDISPONIVEL` (422) | — | O profissional foi desativado |
| `CONSULTA_JA_CANCELADA` (422) | — | Cancelamento repetido |
| `NAO_ENCONTRADO` (404) | — | A consulta não existe **ou pertence a outro paciente** |

Consulta de outro paciente responde exatamente como consulta inexistente. Um
403 não informaria nada ao dono legítimo, que nunca o recebe, e permitiria a
qualquer paciente autenticado contar os registros da clínica percorrendo ids.

Na grade, `?de=` e `?ate=` aceitam instante ISO 8601 ou data sem hora
(`AAAA-MM-DD`), lida como meia-noite **no fuso da clínica**, `America/Fortaleza`.
Janela com fim anterior ao início responde `JANELA_INVALIDA` (422).

## Autenticação

A identidade é do Firebase Authentication. O aplicativo faz login no Firebase e
envia o ID Token em cada requisição protegida:

```
Authorization: Bearer <id-token>
```

A API verifica o token com o Admin SDK. **Uid e e-mail vêm sempre do token
verificado**, nunca do corpo da requisição.

| Rota | O que faz |
|---|---|
| `POST /pacientes` | Cadastra o perfil da conta autenticada |
| `GET /pacientes/me` | Lê o próprio perfil |
| `PATCH /pacientes/me` | Atualiza nome, telefone ou data de nascimento |

Não há rota que receba id de paciente: `/me` é resolvido pelo token, e por
isso ninguém lê o perfil de outra pessoa trocando um número na URL.

Respostas relevantes para o aplicativo:

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

### Credencial do Firebase

Em desenvolvimento, aponte para o JSON da conta de serviço **pelo caminho**:

```
GOOGLE_APPLICATION_CREDENTIALS=C:/caminho/fora/do/repositorio/chave.json
```

Em hospedagem sem arquivo, defina `FIREBASE_PROJECT_ID`,
`FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY` no painel do provedor. Em
produção, a API não sobe sem uma das duas formas.

### Testes e token real

A suíte usa um verificador de token falso, com o mesmo contrato do real, e roda
sem rede e sem credencial. A autenticação com o Firebase de verdade — e, com
ela, o agendamento disputado entre dois pacientes — é provada por um script, com
a API rodando em outro terminal:

```powershell
$env:FIREBASE_WEB_API_KEY = "..."
$env:SENHA_PACIENTE_A     = "..."
$env:SENHA_PACIENTE_B     = "..."
npm run verificar:token
```

O script não imprime token, senha nem chave.

## Licença

MIT.
