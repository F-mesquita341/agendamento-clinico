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

## 14/09/2026 — Revisão: um defeito que a suíte escondia

Revisão do que foi construído até aqui. O achado principal merece registro
porque é metodologicamente interessante.

**O dublê de teste mentia.** O caso de uso `AgendarConsulta` lia o preço da
consulta de `horario.valorCentavos`. Esse campo nunca existiu na entidade
`Horario` — era enxertado à mão pelo utilitário de teste, na montagem do
objeto falso. Em produção a leitura devolveria `undefined`, o operador `??`
converteria para zero, e **toda consulta seria gravada com valor R$ 0,00**.
Os 49 testes passavam, porque validavam um campo que só existia na ficção.

É o modo de falha clássico de dublês: quando o objeto falso oferece mais do
que o real, a suíte deixa de medir o sistema e passa a medir a si mesma.

**Correção.** O valor deixou de ser informado pelo caso de uso. Passou a ser
obrigação do adaptador de persistência, que lê
`profissional.valor_consulta_centavos` dentro da mesma transação e grava em
`consulta.valor_centavos`. Além de corrigir o defeito, a mudança é a modelagem
certa por dois motivos: preço é atributo do profissional, não do horário; e
congelá-lo no ato do agendamento garante que um reajuste posterior não altere
consultas já marcadas.

Os dublês passaram a receber uma tabela de preços por profissional, espelhando
a coluna real, e dois testes novos verificam que a consulta nasce com o preço
certo. A regressão foi confirmada na prática: reintroduzindo o defeito, os dois
testes falham.

**Outras correções menores.** Campo `relogio` sem uso removido de
`CancelarConsulta`; verificação de TLS restrita aos modos que realmente pedem
TLS, para que `sslmode=disable` contra um PostgreSQL local não force conexão
cifrada; o servidor passou a registrar na subida qual transporte está em uso,
já que lentidão inesperada costuma ser WebSocket ligado sem necessidade.

**51 testes passando.**

---

## 15/09/2026 — Etapa 4: endpoints de leitura

**Rede de volta ao normal.** A porta 5432 responde em 199 ms na rede doméstica;
transporte devolvido para `tcp`, que é o padrão. A suíte foi executada nos dois
transportes, com o mesmo resultado — o que confirma que a escolha de driver não
altera comportamento observável.

**Quatro endpoints.** `GET /especialidades`, `GET /profissionais` com filtro e
paginação, `GET /profissionais/:id` e `GET /profissionais/:id/horarios`.

**Busca sem acento.** A busca por nome usa `unaccent` combinado com `ILIKE`.
Sem isso, procurar por "jose" não encontraria "José" — falha justamente nos
nomes mais comuns no Brasil, e num público que inclui pessoas com pouca
familiaridade digital, exigir a acentuação correta seria uma barreira de
usabilidade evitável. Exigiu a migration 004, habilitando a extensão.

**Paginação com total em uma consulta.** `count(*) OVER ()` avalia o conjunto
completo antes do LIMIT, evitando a segunda ida ao banco só para contar. Há uma
exceção: quando a página pedida fica além do fim do conjunto, a função de
janela não devolve linha alguma e o total sai numa consulta própria.

**Apresentadores.** Criada uma camada de tradução entre entidades e JSON, para
que a forma da resposta HTTP não vaze para o domínio. O domínio fala em
`Dinheiro` e `Date`; o cliente recebe centavos, texto formatado e ISO 8601.

**Mensagens de erro em português.** O Zod emite mensagens em inglês por padrão.
Como esta API é consumida por um aplicativo que pode exibir a mensagem direto
ao paciente, e como o trabalho investiga usabilidade, cada regra passou a
declarar a sua própria frase. Um teste verifica que nenhuma mensagem padrão do
Zod vaza — e ele encontrou um vazamento na primeira execução: `invalid_type_error`
não intercepta "Invalid date", que é erro de valor e não de tipo. Corrigido com
`errorMap`.

**72 testes passando**, sendo 19 de integração contra o PostgreSQL real.

---

## 15/09/2026 — Achados da revisão em nuvem

Revisão multi-agente executada sobre os commits `f881416` e `f201081`. Quatro
achados, todos verificados no código e todos procedentes.

**Curingas do LIKE não escapados** (o mais grave). O termo buscado era
interpolado em `%${termo}%` sem tratamento. A consulta é parametrizada, então
não havia injeção de SQL — mas `%` e `_` são curingas do próprio operador e
continuavam valendo dentro do parâmetro. Buscar por `%%` devolvia todos os
profissionais; `__` devolvia qualquer nome com duas letras ou mais. A lista
voltava cheia de gente sem relação com o que a pessoa digitou, e o total da
paginação refletia o curinga, não a busca. Corrigido escapando `\`, `%` e `_`,
com `ESCAPE '\'` explícito na cláusula.

**Comentário que mentia sobre a implementação.** O código afirmava, em
comentário e no diário, que a paginação obtinha página e total em uma consulta
via `count(*) OVER ()` — e então executava duas. Agora executa uma de fato,
medido: uma consulta na página normal, duas apenas quando o deslocamento passa
do fim do conjunto, caso em que a função de janela não devolve linha alguma e
o total precisa ser buscado à parte.

**Mensagem do Zod vazando no filtro de busca.** O Express converte chaves
repetidas da query em array, então `?q=a&q=b` chegava como `['a','b']` e era
recusado com a mensagem padrão da biblioteca, em inglês — exatamente o que o
teste de idioma proíbe, num caminho que ele não exercitava.

**Dublê divergindo do adaptador real.** O adaptador PostgreSQL usa intervalo
semiaberto (`inicio >= de AND inicio < ate`); o dublê usava intervalo fechado.
É a mesma classe de problema do defeito do valor da consulta, encontrado na
revisão anterior: quando o objeto falso não espelha o real, a suíte deixa de
medir o sistema.

Os três primeiros ganharam teste de regressão, e a regressão foi confirmada na
prática — reintroduzindo cada defeito, os testes correspondentes falham.

**77 testes passando.**

---

## 15/09/2026 — Fechamento de lacunas antes das Etapas 5 e 6

Análise da base antes de construir por cima dela. Duas lacunas identificadas e
fechadas.

**`CancelarConsulta` não tinha nenhum teste.** Um caso de uso inteiro sem
cobertura, direta ou indireta — como ainda não existe endpoint de cancelamento,
nada o exercitava. Escritos oito testes, entre eles a verificação de que a
consulta cancelada **não é apagada**, apenas muda de estado: o registro é
matéria-prima da análise de absenteísmo, que é o problema central do trabalho.
Coberto também que o horário volta para a grade com a versão incrementada, e
que outra pessoa consegue agendá-lo em seguida.

**Os guardas de `config.js` só tinham verificação manual.** São eles que
impedem a suíte — que apaga tabelas — de apontar para o banco de
desenvolvimento. Passaram a ter sete testes, executados em processo filho,
porque o módulo chama `process.exit` e isso não pode ser exercitado dentro do
processo do Jest. O diretório de trabalho do filho é uma pasta temporária
vazia, para que o `dotenv` não encontre o `.env` real e contamine o cenário.

O caso mais importante é o do hostname: `-pooler` e o host direto do Neon
alcançam o mesmo banco, e uma comparação de texto entre as duas URLs deixaria
passar. Isso chegou a acontecer de verdade durante a configuração inicial.

Ambos os conjuntos foram validados quebrando o código de propósito: removendo a
verificação de dono no cancelamento e revertendo o guarda para comparação
textual, cinco testes falham.

**Cobertura restante.** Os adaptadores PostgreSQL, os apresentadores e os
esquemas de validação não têm teste direto — são exercitados pelos testes de
integração, que os atravessam por requisição HTTP real. É cobertura pela
fronteira do contrato, e não por dentro, o que se considera adequado: testa o
comportamento observável em vez da implementação.

**92 testes passando**, em 8 suítes.

---
