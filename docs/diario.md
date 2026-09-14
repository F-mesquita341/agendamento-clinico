# Diário de bordo

Uma entrada por sessão de trabalho: o que foi decidido, o que foi descartado e
por quê. O Capítulo 5 da monografia será escrito a partir deste arquivo — sem
ele, decisões de setembro terão que ser reconstruídas de memória em novembro.

---

## 14/09/2026 — Etapas 0, 1 e 2

**Ambiente.** Node.js 24.19.0 e npm 11.17.0 instalados via winget. Git, Flutter,
Dart e Android SDK já estavam presentes na máquina. Repositório criado fora da
pasta sincronizada pelo OneDrive, para evitar que a sincronização de
`node_modules` trave arquivos durante o `npm install`.

**Banco.** Optou-se pelo Neon em vez de PostgreSQL local: elimina a instalação,
mantém o custo em zero conforme o orçamento aprovado e faz o ambiente de
desenvolvimento usar o mesmo serviço da publicação futura no Render.

**Postgres versus Firestore.** Avaliou-se trocar o PostgreSQL por Firestore e
decidiu-se manter o relacional. O Firestore daria conta do agendamento, mas o
controle de concorrência ficaria interno ao serviço, sem a coluna de versão que
as Seções 3.8.3 e 3.9.3 do projeto descrevem e que o Capítulo 5 precisa exibir.
O domínio também é relacional por natureza, e a troca exigiria denormalização.
Firebase permanece no projeto para autenticação e notificações.

**Estrutura.** Camadas separadas conforme a regra de dependência: `domain` e
`application` não importam Express nem `pg`. Configuração validada com Zod na
subida do processo, para que a ausência de uma variável derrube a aplicação com
mensagem legível em vez de falhar no meio de uma requisição.

**Correção de uma decisão anterior.** O plano previa `UNIQUE (horario_id)` na
tabela `consulta`. Está errado: a restrição impediria que um horário cancelado
fosse reagendado, já que a consulta cancelada permanece na tabela — e ela precisa
permanecer, tanto para histórico quanto para a análise de absenteísmo. Foi
substituída por índice único **parcial**, que ignora o estado `cancelada`.

**Pendente.** Levar ao orientador o status da submissão ao CEP e definir o
cenário de coleta de dados.

---

## 14/09/2026 — Etapa 3: domínio e casos de uso

**Camada de domínio.** Entidades `Horario` e `Consulta`, objeto de valor
`Dinheiro` e a abstração `Relogio`. Optou-se por injetar o relógio em vez de
chamar `new Date()` dentro das regras: sem isso, testar "não agendar no passado"
ou "a reserva expirou" exigiria manipular o tempo globalmente.

**Contratos de repositório declarados no domínio**, implementados na infra —
a inversão de dependência do SOLID aplicada de forma concreta.

**Atomicidade.** A reserva do horário e a criação da consulta foram reunidas em
um único método de repositório, `reservarEAgendar`. A decisão é deliberada: a
transação é capacidade do adaptador de persistência, não do caso de uso, que
apenas expressa a intenção. As validações feitas antes dela no caso de uso não
garantem exclusividade — existe uma janela entre verificar e escrever. Quem
garante é o lock otimista. As checagens prévias servem para produzir mensagens
de erro compreensíveis nos casos previsíveis.

**Teste de arquitetura.** Criado `tests/unit/arquitetura.test.js`, que lê os
arquivos de `domain/` e `application/` e falha se algum importar framework,
driver de banco ou camada de borda. A afirmação sobre a regra de dependência
deixa de ser retórica do Capítulo 5 e passa a ser verificável por quem rodar a
suíte.

**47 testes de unidade passando, todos sem banco e sem rede** — a prova prática
de que a separação de camadas funciona.

**Impedimento de infraestrutura.** Os testes de integração pararam de rodar: a
porta 5432 está bloqueada na rede em uso (gateway 10.50.31.254, característico
de rede institucional). A porta 443 do mesmo host responde em 64 ms e o DNS
resolve normalmente, então não é falha do Neon nem do código.

**Transporte alternativo adotado.** Implementada a troca de driver em
`src/infra/db/driver.js`, selecionada pela variável `TRANSPORTE_BANCO`: `tcp`
(padrão, driver `pg` na 5432) ou `websocket` (driver do Neon na 443). A decisão
preserva tudo que o projeto de pesquisa afirma: o banco continua sendo
PostgreSQL, o SQL é o mesmo e o controle de concorrência continua sendo o do
próprio banco. Muda apenas o meio de transporte.

Usou-se o modo WebSocket, e não o modo HTTP do mesmo pacote: o modo HTTP não
sustenta transação, e o agendamento com lock otimista depende de BEGIN/COMMIT
explícito. Verificado empiricamente antes de prosseguir — COMMIT, ROLLBACK e o
`UPDATE ... WHERE versao` devolvendo `rowCount` 1 com a versão correta e 0 com
a versão desatualizada.

O CLI do `node-pg-migrate` sempre abre a conexão em TCP, então foi substituído
por `scripts/migrar.js`, que usa a API programática da mesma biblioteca e
recebe um cliente já criado pelo transporte escolhido. Migrations e aplicação
passam a seguir o mesmo caminho.

**49 testes passando por WebSocket**, numa rede em que a porta do PostgreSQL
não responde.

---
