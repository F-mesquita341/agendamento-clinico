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

## 16/09/2026 — Revisão do repositório completo

Segunda revisão em nuvem, desta vez sobre os 50 arquivos do repositório
inteiro — a primeira usara o commit inicial como base e deixara de fora todo o
núcleo: entidades de domínio, as três migrations centrais e `config.js`. Cinco
achados, todos verificados no código e todos procedentes.

**Erros do analisador de corpo virando 500.** O `express.json()` roda antes de
qualquer rota e levanta erros próprios: corpo acima do limite de 100 kB
(`entity.too.large`, 413), codificação e conjunto de caracteres não suportados
(415). O tratador só reconhecia JSON malformado, então todos os demais caíam no
ramo genérico: o cliente recebia 500 com `ERRO_INTERNO` e o servidor registrava
"erro não tratado" a cada requisição grande demais. Duas consequências —
o cliente não conseguia distinguir violação de tamanho de falha real do
servidor, e o monitoramento ficaria poluído de falsos erros internos, onde
falhas de verdade se esconderiam. Corrigido com um mapa dos tipos conhecidos e
uma rede de segurança que impede qualquer erro já declarado como 4xx de virar
500.

**ROLLBACK sem isolamento em `transacao`.** Se o `ROLLBACK` de limpeza também
falhasse — o que acontece justamente quando a conexão caiu, que costuma ser a
causa do erro original —, a falha do `ROLLBACK` substituía o erro real, e o
cliente voltava ao pool sem ser destruído. O próximo a pegá-lo receberia
"current transaction is aborted" sem ter feito nada. Agora o erro original é
sempre propagado, e o cliente é devolvido com o erro quando o `ROLLBACK` falha,
o que faz o `pg` destruí-lo. O momento de corrigir era este: `transacao` ainda
não tem nenhum chamador, e a Etapa 6 inteira vai depender dela.

**Restrição que não cumpria o próprio comentário.** A migration 003 descrevia
`pagamento.ambiente` como trava impedindo linhas de produção, mas a restrição
era `CHECK (ambiente IN ('sandbox','producao'))` — aceitava 'producao' em
silêncio. Comentário e schema diziam coisas diferentes, e o comentário é o que
um mantenedor lê antes de decidir se precisa de proteção na aplicação. A
migration 005 aperta para `CHECK (ambiente = 'sandbox')`, alinhando o banco ao
que a Seção 3.9.5 do projeto declara. Verificado na prática: um INSERT com
'producao' agora é recusado pelo banco.

**Healthcheck sem prazo próprio.** `GET /saude` aguardava o `SELECT 1` pelo
tempo de conexão do pool — 15 s em TCP, 30 s por WebSocket. Durante a
hibernação do Neon, cada sondagem seguraria um processo de trabalho por esse
período inteiro antes de responder, o oposto do que um healthcheck existe para
fazer, e uma rajada esgotaria a capacidade da API enquanto ela apenas parecia
lenta. Passou a ter prazo de 3 segundos, respondendo 503 ao estourar.

**Exemplo de uso desatualizado** no cabeçalho de `tests/helpers/servidor.js`,
mostrando `iniciar()` sem `await` depois que a função virou assíncrona.

Os dois achados com comportamento observável ganharam teste de regressão,
confirmada na prática: revertendo o tratador de erros, dois testes falham.

**95 testes passando.**

---

## 16/09/2026 — Etapa 5: autenticação e cadastro de pacientes

**Projeto Firebase** `agendamento-clinico-bd390`, com login por e-mail e senha e
dois usuários de teste em `example.com`, domínio reservado para esse fim.

**A chave privada nunca entrou no `.env`.** O plano original previa copiar três
campos do JSON da conta de serviço para o `.env`. Foi abandonado ao notar que o
ambiente de desenvolvimento assistido exibe o conteúdo do `.env` sempre que ele
muda — motivo pelo qual a senha do banco já havia aparecido em registros de
trabalho. O `.env` guarda apenas `GOOGLE_APPLICATION_CREDENTIALS`, com o caminho
do arquivo, que fica fora do repositório e fora da pasta sincronizada com a
nuvem. Para hospedagem sem arquivo, a configuração aceita as três variáveis
`FIREBASE_*`, a serem definidas no painel do provedor.

**Verificador de token injetável.** O aplicativo Express passou a ser montado
por uma fábrica, `criarApp({ verificarToken })`. Em produção, o verificador é o
do Firebase, inicializado só na primeira requisição autenticada; nos testes, um
verificador falso com o mesmo contrato. Isso mantém a suíte sem dependência de
rede e de credencial — condição para rodar no GitHub Actions, que não tem acesso
ao Firebase. A autenticação com token real é provada à parte, por
`scripts/verificar-token-real.js`, executado pelo autor no próprio terminal,
para que senhas dos usuários de teste não circulem em registro nenhum.

**Falha do servidor não vira 401.** O adaptador traduz em 401 apenas uma lista
fechada de códigos do Firebase que significam "token inválido". Credencial
ausente, chave corrompida ou queda de rede ao buscar as chaves públicas do
Google continuam sendo erro interno: traduzi-los em 401 mandaria a pessoa
refazer login num sistema quebrado do lado do servidor, e esconderia a falha do
monitoramento. É a mesma classe de problema apontada na revisão anterior, quando
erros do analisador de corpo apareciam como 500.

**Identidade vem do token, nunca do corpo.** Uid e e-mail são lidos do token
verificado. Corpos com `email` ou `firebaseUid` são recusados com 422. Não existe
rota que receba id de paciente: `/pacientes/me` é resolvido pelo token, o que
torna o isolamento entre pacientes uma propriedade da estrutura das rotas, e não
de uma verificação que alguém possa esquecer.

**Consentimento LGPD como pré-condição.** O cadastro exige o aceite da versão
vigente do termo (`docs/termo-de-consentimento.md`, em rascunho para revisão com
o orientador). O instante do aceite é o do servidor — um horário enviado pelo
aplicativo não prova nada. A migration 006 torna as duas colunas de
consentimento obrigatórias no próprio banco: não existe paciente sem prova de
consentimento, mesmo que alguém insira pelo painel. Verificado na prática: o
PostgreSQL recusa o INSERT.

**Minimização de dados.** Não se coleta CPF, endereço nem documento; nada no
escopo precisa deles.

**Auditoria na mesma transação** do cadastro e da atualização, registrando nomes
de campos e nunca valores. Primeiro uso real de `transacao()` depois da correção
do ROLLBACK na revisão do repositório completo.

**Cadastro concorrente.** Dez cadastros simultâneos da mesma conta resultam em
exatamente um sucesso: todos passam pela checagem prévia do caso de uso, e a
restrição UNIQUE do banco decide. A violação (código 23505, restrição
`paciente_firebase_uid_key`) é traduzida em 409 — só essa restrição, para que
outras violações continuem aparecendo como defeito.

**Trocas registradas.** Sem verificação de revogação de token a cada requisição:
exigiria uma chamada aos servidores do Firebase por requisição, e a latência
pesa na percepção de usabilidade medida pelo SUS; tokens expiram em uma hora.
E-mail verificado não é exigido, para não acrescentar uma etapa de confirmação
nas sessões de teste com participantes. Ambas são limitações a declarar no
Capítulo 7.

**Dependência com alerta moderado não corrigido.** O `firebase-admin` traz o
`gaxios`, que depende de `uuid@9`, alvo de alerta sobre v3/v5/v6 com buffer
fornecido pelo chamador. O `gaxios` usa apenas `uuid.v4()` sem argumentos, então
o caminho vulnerável não é alcançável. Forçar o `uuid@11` por baixo de uma
dependência que declara `^9` traria mais risco do que o alerta. O `engines` do
projeto subiu para Node 22, exigência do `firebase-admin` 14.

**Revisão própria** encontrou três problemas antes do commit: mensagens de data
de nascimento enganosas ("abc" produzia também "não pode estar no futuro",
porque "abc" é maior que "2026-..." na comparação de texto); `atualizar` no
adaptador montando SQL inválido quando chamado sem campos e quebrando se o
paciente sumisse entre leitura e escrita; e um método de domínio sem uso. Além
disso, variáveis opcionais vazias no `.env.example` impediriam a API de subir —
passaram a contar como ausentes.

Os testes de regra de segurança foram confirmados reintroduzindo quatro
defeitos: toda falha do Firebase virando 401, violação de unicidade sem
tradução, horário do consentimento aceito do cliente, e PATCH aceitando campos
não permitidos. Oito testes falharam.

**178 testes passando.**

---
