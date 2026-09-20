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

## 16/09/2026 — Firebase Admin carregado na subida

**O incidente.** Na primeira execução da verificação com token real, os dois
tokens foram emitidos pelo Firebase, mas a primeira chamada autenticada à API
terminou em conexão derrubada, sem resposta. A investigação mostrou que a API
havia sido reiniciada pelo `node --watch` no instante da requisição, sem nenhum
arquivo do projeto alterado, e que uma requisição com token inválido não
derrubava o processo.

A explicação que fecha com as evidências: o SDK era carregado sob demanda, na
primeira requisição autenticada. Isso lê pela primeira vez centenas de arquivos
da biblioteca; no Windows, a inspeção desses arquivos pelo antivírus é tomada
como mudança pelo vigia de recarga, que reinicia a API no meio da resposta. Não
se repetiu uma vez que os arquivos já estavam inspecionados.

**A correção.** O servidor passou a carregar o Firebase Admin na subida, antes
de abrir a porta. Medido: 121 ms de carregamento na subida, e a primeira
requisição autenticada respondeu em 42 ms. Além de eliminar a interação com o
vigia, isso tira a espera da primeira pessoa a entrar no aplicativo — relevante
para as sessões de teste medidas pelo SUS. A suíte não passa por esse caminho:
monta o app com o verificador falso.

**Validação da chave na subida.** Constatou-se que o SDK não lê o arquivo de
credencial ao inicializar, só ao verificar o primeiro token. Carregar na subida
sem validar daria uma falsa impressão de prontidão. A configuração passou a
conferir se o arquivo é JSON válido e se contém `type`, `project_id`,
`client_email` e `private_key`, citando no erro só os nomes dos campos.

**Um teste que não media nada.** O teste de que o erro de JSON inválido não
vaza conteúdo da chave passou mesmo com o vazamento reintroduzido de propósito.
Motivo: o arquivo de teste era um JSON truncado, para o qual o V8 emite
"Unterminated string" sem citar o texto — não havia o que vazar. O V8 só cita
trecho em erros de caractere inesperado, e mesmo assim só uns dez caracteres ao
redor. O teste foi refeito com um valor sem aspas, que produz o trecho, e passou
a procurar o fragmento em vez do texto inteiro. Reintroduzido o vazamento, agora
falha. É a terceira ocorrência, neste trabalho, de teste verde sobre defeito —
as duas anteriores foram dublês que não espelhavam o adaptador real. Confirmar
cada teste de regra de segurança reintroduzindo o defeito deixou de ser cuidado
extra e passou a ser parte do método.

**Porta ocupada.** O servidor passou a explicar, sem pilha de erro, quando a
porta já está em uso — situação que ocorreu na prática ao subir a API com outra
cópia já aberta em outro terminal. E o script de verificação passou a mostrar a
causa real de falhas de conexão, que antes ficava escondida atrás de
"fetch failed".

**181 testes passando.**

---

## 16/09/2026 — Portão da Etapa 5 atingido

Verificação executada pelo autor às 17:13, com a API rodando localmente e
`scripts/verificar-token-real.js` usando **tokens reais emitidos pelo Firebase**
para os dois usuários de teste. As catorze verificações passaram:

- tokens emitidos pelo Firebase para os usuários A e B;
- cada token cadastrou o próprio perfil (201) e o leu de volta (200), com o
  e-mail da conta correspondente;
- o perfil lido com o token de A não contém dado de B, e vice-versa, e os dois
  tokens resolvem para pacientes diferentes;
- token com assinatura adulterada foi recusado (401), assim como requisição sem
  token (401).

Conferido depois no banco de desenvolvimento: dois pacientes, ambos com
consentimento registrado na versão `2026-09-v1` e horário do aceite marcado pelo
relógio do servidor; duas linhas de auditoria `paciente.cadastrado`, sem nome,
e-mail ou telefone no detalhe.

Com isso, a Etapa 5 cumpre o portão definido no plano: um token real do Firebase
autentica uma requisição de ponta a ponta, e um paciente não alcança dado de
outro. A suíte automatizada cobre o mesmo comportamento com verificador falso,
em 181 testes; a execução com token real prova que o contrato do verificador
falso corresponde ao do Firebase.

A execução anterior, às 16:37, havia falhado por queda da conexão — registrado
na entrada sobre o carregamento do Firebase Admin na subida, que foi a correção.

---

## 16/09/2026 — Revisão em nuvem da Etapa 5

Terceira revisão multi-agente, sobre os 30 arquivos da Etapa 5. Três achados,
todos de gravidade baixa, todos verificados no código e procedentes. Nenhum
conflitou com decisão tomada de propósito.

**"Hoje" calculado em UTC.** A validação de data de nascimento comparava a data
informada com `new Date().toISOString()`, que é o dia em UTC. Em Quixadá, entre
21h e meia-noite, o UTC já está no dia seguinte — e a data de amanhã passava
como data de nascimento válida. O servidor de hospedagem costuma rodar em UTC,
então o problema não depende da máquina de desenvolvimento. Corrigido calculando
o dia civil no fuso da clínica, `America/Fortaleza`, o mesmo do seed. Testado
com relógio simulado às 22h30 locais.

**Leitura redundante no `AtualizarPerfil`.** O caso de uso lia o paciente só para
lançar 404, mas a rota já o havia resolvido pelo token e o adaptador já lança
404 quando o UPDATE não alcança nenhuma linha. Cada PATCH fazia uma ida a mais
ao banco. A leitura saiu, o contrato do repositório passou a declarar o 404, e o
dublê passou a espelhá-lo — sem isso, o dublê montaria um paciente a partir de
`undefined` e o teste passaria sobre o defeito, a mesma armadilha já registrada
duas vezes neste diário.

**Arquivo de credencial validado mesmo sem ser usado.** Quando as três variáveis
`FIREBASE_*` estão definidas, elas têm prioridade sobre o arquivo — mas o arquivo
era validado antes dessa decisão. Um caminho antigo esquecido no painel do
provedor, durante a migração de uma forma de credencial para a outra, impediria
a API de subir. Agora o arquivo só é validado quando é a credencial em uso; se as
duas formas estiverem presentes, a subida emite aviso para remover a que sobra.

Os três achados ganharam teste, e cada teste foi confirmado reintroduzindo o
defeito correspondente: três falhas.

**187 testes passando.**

---

## 17/09/2026 — Etapa 6: agendamento com lock otimista

O domínio e os casos de uso estavam prontos desde a Etapa 3, mas rodavam só
contra dublês em memória: `RepositorioDeHorariosPg` era leitura pura e
`RepositorioDeConsultasPg` não existia. Esta etapa ligou as peças ao PostgreSQL
e as expôs por HTTP. Nenhuma migration — tabelas, coluna `versao` e índice
parcial vieram da Etapa 2.

**O lock otimista cabe em um UPDATE.** `WHERE id = $1 AND versao = $2 AND status
= 'disponivel'`. Sob concorrência, a segunda transação fica bloqueada na linha
até a primeira confirmar; quando o bloqueio sai, o PostgreSQL reavalia o WHERE
sobre a linha já atualizada, a versão não confere mais e o UPDATE não alcança
nenhuma linha. Não existe "ler, decidir, escrever": a decisão é a própria
escrita. O adaptador devolve `null`, e o caso de uso traduz em 409.

**O preço é lido do profissional dentro da transação** e congelado na consulta.
Um reajuste amanhã não altera consulta marcada hoje. É o mesmo ponto em que o
`horario.valorCentavos` fantasma tinha se escondido na Etapa 3.

**Profissional desativado passou a ser recusado.** Desativar tira os horários
das listagens, mas um aplicativo com a tela antiga aberta ainda conseguiria
agendar. A verificação acontece depois do UPDATE, e o ROLLBACK desfaz a reserva
— o teste confere que o horário continua disponível na versão original.

**O teste de concorrência revelou algo para a Etapa 7.** Vinte requisições
simultâneas do mesmo paciente produzem um 201 e dezenove recusas, mas as
recusas vêm em dois sabores: 409 quando perderam a disputa pela versão, e 422
`CONSULTA_SOBREPOSTA` quando a checagem prévia rodou depois de a vencedora ter
gravado — nesse instante o horário já conflita com a agenda do próprio paciente.
Ambas são recusas legítimas, mas o teste de carga da Etapa 7 precisa usar
pacientes distintos, ou o resultado publicado misturaria dois fenômenos.

**Um teste verde que não provava nada.** O caso mais instrutivo do dia: o teste
de dois cancelamentos simultâneos via HTTP passou mesmo depois de eu remover a
trava do adaptador. Motivo: a checagem prévia do caso de uso pegava o segundo
pedido antes de ele chegar ao banco — o que depende de tempo, não de garantia.
A trava verdadeira só é exercitada quando os dois pedidos leem o estado antes de
qualquer um gravar. Escrevi então um teste que chama o adaptador diretamente,
sem passar pelo caso de uso, e ele falha sem a trava. É a quarta ocorrência de
teste verde sobre defeito neste trabalho — as três anteriores foram dois dublês
que não espelhavam o adaptador real e o teste de vazamento da chave privada —, e
a quarta em que só reintroduzir o defeito revelou isso. Com uma diferença: desta
vez o culpado não foi um dublê, e sim a suposição de que duas requisições
disparadas juntas de fato se cruzam no banco.

**Cancelar relê sob bloqueio.** O plano previa `WHERE status <> 'cancelada'` no
UPDATE; acabou melhor: `SELECT ... FOR UPDATE` e a verificação do próprio
domínio, `Consulta.garantirQuePodeSerCancelada()`, extraída do método que já
existia. Assim a mensagem certa para cada estado continua morando num lugar só,
e o adaptador não duplica regra de negócio.

**Por que isso importa:** sem essa trava, um cancelamento reenviado — dedo duplo
no botão, aplicativo repetindo depois de uma queda de rede — liberaria um
horário que outra pessoa já teria reservado no intervalo. O teste que prova isso
é o de "cancelamento repetido não rouba o horário de quem reservou depois".

**`liberar` nasceu com chamador.** Em vez de esperar a rotina de expiração da
Etapa 8, recebe um `executor` opcional e é usado pelo cancelamento dentro da
transação. Só age sobre horário `reservado`: o que a clínica bloqueou continua
bloqueado.

**Leitura composta.** As telas mostram data, profissional e especialidade junto
com a consulta, então `doPaciente` devolve `{ consulta, horario, profissional }`
por JOIN, e não uma requisição por item. As traduções de linha para entidade são
reaproveitadas dos outros adaptadores — o horário que aparece na consulta é
montado pelo mesmo código que monta a grade.

Cinco defeitos reintroduzidos de propósito, cinco falhas no teste esperado:
comparação de versão, trava do cancelamento, preço do profissional, profissional
inativo e o middleware que resolve o paciente do token.

**219 testes passando.**

---

## 18/09/2026 — Revisão local do código inteiro

A revisão em nuvem ficou indisponível — a cota gratuita acabou —, então a
revisão foi feita localmente, sobre todo o `src/`, com cinco ângulos de busca
independentes: varredura linha a linha, rastreamento de contratos entre
arquivos, armadilhas de linguagem e de SQL, adaptadores e concorrência, e
limpeza. Quinze achados sobreviveram à verificação. Nove foram corrigidos agora;
seis ficaram para as etapas em que fazem sentido.

**O mais grave repetia o padrão de dois dias atrás.** A regra "o paciente não
fica em dois lugares ao mesmo tempo" era verificada por uma leitura fora da
transação, e nada no banco a garantia. Dois pedidos simultâneos para horários
DIFERENTES e sobrepostos passavam juntos: cada um reservava a sua própria linha
de horário, versões distintas, nada em comum para disputar — o lock otimista
não tinha o que proteger. O teste existente rodava em sequência e passava. Três
dos cinco ângulos encontraram isso de forma independente.

O teste novo, com os dois pedidos em paralelo, foi escrito ANTES da correção e
falhou com dois 201 — o defeito observado, não apenas raciocinado. A correção é
a migration 007: uma restrição de exclusão `EXCLUDE USING gist (paciente_id
WITH =, periodo WITH &&)`, parcial como o índice de horário. Exigiu copiar o
período do horário para a consulta, porque uma restrição só enxerga a própria
tabela — o que tem um efeito colateral bom: a duração combinada fica congelada
junto com o preço.

É a quinta ocorrência de teste verde sobre defeito neste trabalho, e a segunda
do mesmo tipo em dois dias. Deixou de ser acaso e virou regra de projeto: **toda
regra que compara estado antes de gravar precisa de rede de segurança no
banco.** No horário, o índice parcial; no cancelamento, o `FOR UPDATE`; na
agenda do paciente, a restrição de exclusão.

**500 em rota pública.** `Number.isInteger(1e21)` é verdadeiro, então
`?pagina=1e21` atravessava a validação; o driver serializava o número como
"1e+21" e o PostgreSQL recusava. Qualquer pessoa, sem token, gerava erro
interno no log à vontade. Confirmado com requisição real antes de corrigir.

**Coerção no corpo JSON.** O esquema de inteiro usado nas rotas converte texto
em número, o que faz sentido em query string. No corpo do agendamento, convertia
`true` em 1 — e `{"horarioId": true}` agendava o horário 1, que o paciente nunca
viu. O corpo passou a usar um esquema sem coerção.

**A grade lia datas em UTC.** `?de=2026-10-01` virava 30 de setembro às 21h em
Quixadá. O mesmo erro já tinha aparecido na data de nascimento, na Etapa 5, e a
correção de lá não tinha sido estendida à grade.

**Consulta de outro paciente passou a responder 404.** A decisão anterior, 403,
tinha um custo que não fora pesado: o dono legítimo nunca recebe 403, então a
distinção não informava nada a quem tinha direito, e permitia a qualquer
paciente autenticado contar os registros da clínica percorrendo ids. O domínio
continua lançando `AcessoNegado`; a política de não revelar existência é da
fronteira HTTP.

**Dublês que não cumpriam o contrato.** Nenhum dos três estendia a classe
abstrata do domínio, e um deles não tinha `leituraPorId`. Agora estendem, e um
teste de arquitetura compara os métodos do contrato com os de cada dublê — ele
aponta pelo nome o método que falta.

**Mais um teste verde, pego a tempo.** O primeiro teste da ordenação estável
passou mesmo sem a correção: numa tabela pequena o PostgreSQL devolve as linhas
na ordem física, que coincidia com a do id. Foi reescrito gravando as duas
linhas em ordem física inversa, e aí falhou com o defeito. É o mesmo cuidado de
ontem, aplicado a mim mesmo no mesmo dia: sem reintroduzir o defeito, esse teste
teria entrado no repositório provando nada.

**Adiados, com motivo:** revogação de token e tempos limite de transação e do
healthcheck ficam para a Etapa 10, que é a de endurecimento; o desligamento
gracioso, para a Etapa 8, quando houver um Render de verdade para observar; a
consulta única com CTE no caminho do agendamento, para o início da Etapa 7, onde
dá para medir o ganho antes e depois; e as quatro duplicações de código, para a
Etapa 10, já que o escopo escolhido foi só correção.

Cada correção foi confirmada reintroduzindo o defeito.

**235 testes passando.**

---

## 18/09/2026 — Portão da Etapa 6 com token real

Script executado pelo Felipe, com a API em outro terminal e tokens reais do
Firebase: **22 verificações, todas aprovadas.** O bloco novo prova, fora da
suíte automática, o que a Etapa 6 promete: A agenda (201) e a consulta nasce
com o preço do profissional; B, com a mesma versão em mãos, recebe 409 com a
ação de recarregar a grade; B não enxerga a consulta de A (404, igual a uma
consulta inexistente); A cancela, e o horário volta à grade com a versão
adiantada em dois.

**A primeira execução ficou parada, sem mensagem nenhuma.** O diagnóstico: a
porta 3000 pertencia ao `npm run dev` do próprio dia, vivo, que aceitava a
conexão mas não respondia — nem o 503 que o `/saude` devolve sozinho em três
segundos. Ou seja, travado, não lento. O título da janela era "Selecionar npm
run dev": no console clássico do Windows, um clique dentro da janela ativa o
modo de seleção, e o processo congela na próxima vez que escreve na tela. Um
Esc resolveu, e o script seguiu sozinho de onde tinha parado.

Fica registrado por dois motivos. Vai acontecer de novo em demonstração —
inclusive diante da banca —, então o README ganhou a instrução. E o script
tinha parte da culpa: esperava para sempre, em silêncio. Ganhou prazo de 15
segundos por chamada e uma mensagem que distingue API desligada (conexão
recusada) de API travada (prazo estourado), já com a instrução do Esc. Os dois
caminhos foram testados contra um servidor que aceita e nunca responde e
contra uma porta vazia.

---

## 18/09/2026 — Etapa 7: teste de concorrência

> **Corrigida em 19/09/2026.** Partes desta entrada afirmam mais do que o
> experimento mede: a causa da divisão das recusas não foi medida, a
> "contenção máxima" é limitada pelo pool, e o ganho da otimização está
> superestimado. Mantida como estava, por registro — as correções estão em
> "Revisão local da Etapa 7", mais abaixo. Não usar esta entrada sozinha como
> fonte para o Capítulo 6.

O critério da Seção 4.5 — "zero conflitos detectados no teste de carga simples
com cem requisições simultâneas para o mesmo horário" — foi atendido: **10 de
10 rodadas aprovadas pelo HTTP e 10 de 10 direto no adaptador, zero
agendamentos duplicados.** Relatórios em `docs/resultados/concorrencia/`.

**Duas fases, porque são duas perguntas.** Pelo HTTP, o caminho completo da API
responde se o sistema aguenta. Direto no adaptador, sem a checagem prévia do
caso de uso, responde se é o lock que garante. Cem pacientes distintos por
rodada: com o mesmo paciente, parte das recusas viria da regra de agenda
sobreposta e o número misturaria dois fenômenos.

**Vocabulário fixado.** Conflito é agendamento duplicado. O `409` de quem perdeu
a disputa é recusa, e 99 por rodada é o resultado correto. O HTTP chama o 409 de
*Conflict*; o relatório e a monografia precisam separar as palavras, ou um
avaliador lê "99 conflitos" onde há 99 acertos.

**O resultado mais interessante contrariou o que eu temia.** A preocupação era
que a checagem prévia do caso de uso absorvesse as recusas — o pedido lê o
horário já reservado e é recusado antes da transação —, e o experimento passasse
sem nunca exercitar o lock. Por isso a fase HTTP ganhou um contador que separa
as duas camadas. Resultado: **100% das recusas, em todas as rodadas, foram
decididas pelo `UPDATE` com a versão; nenhuma pela checagem prévia.** A causa é a
fila do pool de conexões: as cem requisições enfileiram suas leituras antes de
qualquer transação começar, então todas leem o horário livre e chegam juntas ao
UPDATE. Contenção máxima exatamente no mecanismo que se queria medir — agora
medido, não suposto.

O mesmo fenômeno explica por que o vencedor leva cerca de 2 segundos: as
leituras prévias das cem requisições passam na frente dele na fila.

**Simultaneidade real.** As cem requisições chegam ao servidor em 4 a 9 ms. A
medida é o instante de chegada ao servidor, e não o de disparo no cliente — o
laço que cria as cem promessas leva menos de um milissegundo e não diria nada.

**O detector foi testado antes de ser usado.** O sistema não produz duplicidade
sem desmontar três defesas ao mesmo tempo, então não há defeito a reintroduzir
no código para ver o experimento falhar. As funções que avaliam cada rodada
foram separadas e testadas com entradas sintéticas — dois 201, duas consultas no
banco, um 500, um 422, resposta faltando, valor errado —, e cada uma sai
reprovada.

**A otimização medida.** A transação do agendamento fazia duas idas ao banco
antes de inserir a consulta: o UPDATE e a leitura do profissional. Uma CTE as
juntou. Comparando as medianas das duas execuções oficiais:

| | antes | depois | diferença |
|---|---|---|---|
| Fase HTTP, duração da rodada | 3978 ms | 3873 ms | −2,6% |
| Fase HTTP, latência do vencedor | 2070 ms | 2008 ms | −3,0% |
| Fase HTTP, p50 das 1000 requisições | 3159 ms | 3051 ms | −3,4% |
| Adaptador, p50 das 1000 chamadas | 1428 ms | 1287 ms | −9,9% |

Todas as métricas andaram na mesma direção, e o ganho do vencedor, 62 ms, é da
ordem de uma ida ao Neon — exatamente o que a mudança elimina. Mas é uma
execução de cada lado, com cinco minutos de distância e faixas que se
sobrepõem. **É indício consistente, não prova estatística**, e é assim que deve
aparecer no Capítulo 6. Para afirmar mais, seria preciso alternar várias
execuções de cada versão.

A CTE tem uma armadilha, registrada no código: o UPDATE dentro dela acontece
mesmo que o SELECT de fora não devolva linha. Com JOIN interno, um profissional
ausente faria o horário ser reservado e o método responder como se a versão não
conferisse. Com LEFT JOIN, cai na recusa, e o ROLLBACK desfaz a reserva. Os
defeitos de preço e de profissional inativo foram reintroduzidos sobre o código
novo e derrubaram os dois testes certos.

**Para a monografia:**

- A Seção 3.8.3 diz que a coluna de versão fica "na tabela de consultas"; a
  implementação a põe em `horario`, que é o recurso disputado — quando duas
  pessoas competem, a consulta ainda não existe. O texto precisa de ajuste.
- Na disputa por um horário novo, o próprio `status = 'disponivel'` do UPDATE já
  impede duplicidade. O papel que só a versão cumpre é recusar a leitura
  desatualizada do tipo ABA — disponível, reservado, cancelado, disponível de
  novo, e alguém agendando com a tela antiga —, coberto por teste próprio. O
  teste de carga prova a **combinação** das defesas; atribuir o resultado só ao
  lock otimista seria impreciso.
- Limitações declaradas no próprio relatório: cliente e servidor no mesmo
  processo; verificador de token falso, sem o custo da assinatura do JWT;
  máquina local contra o Neon em São Paulo; um único horário por rodada.

A integração contínua passa a rodar o teste de concorrência em modo ensaio a
cada envio — quando o repositório remoto existir.

**260 testes passando.**

---

## 19/09/2026 — Revisão local da Etapa 7

Revisão com dois revisores independentes: um de correção do código, outro de
**método** — se o experimento mede o que o relatório e este diário afirmam. O
segundo foi o mais valioso. Quinze achados, todos corrigidos. A conclusão
central se manteve: zero agendamentos duplicados. O que não se sustentava eram
afirmações sobre *qual defesa* decidia e *em que nível* houve simultaneidade.

**O experimento não distinguia o lock do índice.** O adaptador devolve `null`
tanto quando o UPDATE condicional não alcança a linha quanto quando o índice
único recusa o INSERT, e nos dois casos o banco termina igual — o ROLLBACK
desfaz a reserva. O avaliador aprovaria uma rodada em que o índice, e não o
UPDATE, tivesse segurado os perdedores. A distinção veio da sequência de ids de
`consulta`: toda tentativa de INSERT consome um número, mesmo desfeita. Rodada
correta avança a sequência em exatamente um.

**Validado removendo as defesas do código:**

| Código | Fase A | Fase B | Fase C | Critério 4.5 |
|---|---|---|---|---|
| Correto | 10/10 | 10/10 | 10/10 | atendido |
| UPDATE sem versão e sem status | 0/10 — 100 inserções por rodada | 0/10 — idem | 0/10 — pedido desatualizado aceito | **ainda atendido** |
| UPDATE sem a condição de versão | 10/10 | 10/10 | **0/10** — pedido desatualizado aceito | atendido |

Três leituras para o Capítulo 6:

- **Defesa em profundidade, demonstrada.** Com o UPDATE sem condição nenhuma,
  continuou havendo zero duplicidades: o índice único segurou. O critério da
  4.5 sozinho não teria percebido nada; foi a sequência que acusou, em todas as
  30 rodadas. As rodadas ficaram duas vezes mais lentas, porque cada perdedor
  passou a inserir e desfazer segurando o bloqueio.
- **O papel próprio do lock otimista só aparece na fase C.** Sem a condição de
  versão, as fases A e B passaram inteiras — o status basta para disputa por
  horário novo, como já previa a nota de ontem. Só a leitura desatualizada
  (reservado, cancelado, disponível de novo, e alguém agendando com a tela
  antiga) revela a falta dela: um pedido antigo é aceito e quem tinha a versão
  atual fica sem o horário. Sem a fase C, o experimento inteiro passaria com o
  mecanismo central do trabalho desligado.
- **É a quinta vez que um teste verde esconderia um defeito**, e a primeira em
  que o que estava cego era o próprio experimento de avaliação.

**Correções ao texto de ontem** (a entrada de 18/09 ganhou um aviso):

- *"Agora medido, não suposto"*, sobre a fila do pool explicar os 0% de recusas
  na checagem prévia: o que foi medido é a divisão 0/99; a causa é **hipótese**
  compatível com as latências — o vencedor em ~2 s bate com ~36 idas de ~55 ms
  —, não registrada. E, se vale, o 0% é artefato da forma da carga, não
  propriedade do sistema.
- *"Chegam juntas ao UPDATE. Contenção máxima"*: no banco, o pool limita a 10
  transações simultâneas. Os dados da fase B mostram os primeiros pedidos
  terminando em escada de ~55 ms — o tempo de uma ida —, compatível com uns
  nove perdedores por rodada esperando o bloqueio da linha, um de cada vez; os
  outros ~90 encontram o horário já reservado. "Cem simultâneas" vale para a
  chegada ao servidor, não para o banco.
- *O ganho da otimização estava superestimado.* O −9,9% no p50 do adaptador é
  cerca de 2,5 idas, e a mudança elimina uma, só no vencedor; o excesso coincide
  com instabilidade da execução de base. A métrica que isola a mudança estava
  nos JSON e não foi usada: **o vencedor da fase B caiu de 324–368 ms para
  270–287 ms, nas dez rodadas — cerca de 55 ms, uma ida ao banco.** É esse o
  número para o texto. Detalhe de cálculo: a "mediana" usada é o posto mais
  próximo, e as 1000 latências não são amostras independentes, porque cada uma é
  quase só função da posição na fila.
- A recusa atribuída "à versão", nas fases A e B: versão e status falham juntos
  para todo perdedor. Agora o relatório diz isso, e a fase C isola a versão.

**Correções no executor.** Um erro no meio das rodadas deixava o servidor HTTP
aberto e o processo pendurado; na CI, seis horas presas. Verificado com uma
falha simulada: a versão anterior continuava parada quando foi morta aos 60 s;
a nova termina em um segundo com código 1. Também: vigia de 15 minutos e prazo
no passo da CI; contadores por horário; critério e anomalias em vereditos
separados — uma resposta 500 é anomalia, não conflito, e o relatório não pode
dizer "critério não atendido" por causa dela; ambiente lido da própria conexão
(o relatório afirmava "Neon em São Paulo" fixo); nome de arquivo que não
sobrescreve.

**Execução oficial, com as três fases:** 30 de 30 rodadas sem anomalia, zero
conflitos, relatório `2026-09-19-140759-fcee49d`. Neon sa-east-1 por conexão
direta, READ COMMITTED, 56 ms por ida ao banco. A chegada ao servidor ficou
entre 11 e 106 ms, contra 4 a 9 ms ontem — a causa não foi investigada, e nos
dois casos é duas ordens de grandeza menor que a duração da rodada, de 2 a 4 s.

Os dois relatórios de 18/09 ficam no repositório, como registro. O texto deles
foi substituído pelo de hoje; os dados continuam válidos, e são deles que sai a
comparação do vencedor da fase B.

**Para a monografia**, além das notas de ontem: dez rodadas sem falha, mesmo
tratadas como independentes, deixam o limite superior de 95% da taxa de falha
por rodada em cerca de 26%. A garantia vem do mecanismo — o UPDATE condicional
sob READ COMMITTED, e o índice por trás dele —, e o teste a **corrobora**. O
texto deve dizer isso nessa ordem.

**268 testes passando.**

---

## 19/09/2026 — Etapa 8, parte A: pagamento, webhook e expiração

A parte que não depende de contas externas: o ciclo da consulta fecha. Ela
nasce aguardando pagamento, o paciente abre o checkout, o Mercado Pago avisa, a
consulta é confirmada — ou a reserva vence e o horário volta à grade. O
Mercado Pago é um dublê nos testes; a integração de verdade é a parte B.

**Decisões principais.**

- *Checkout Pro*, não formulário de cartão no app: nenhum dado de cartão passa
  pela API.
- *Só o webhook confirma, e nunca pelo conteúdo do aviso.* A notificação diz "o
  pagamento X mudou"; a API busca X no próprio Mercado Pago e confere valor,
  moeda e modo sandbox antes de confirmar.
- *Assinatura antes de tudo*, HMAC SHA-256 com comparação em tempo constante.
  **Desvio do plano:** não há recusa por instante antigo. Como o estado é sempre
  buscado no provedor, reproduzir um aviso legítimo é inofensivo; e se o
  Mercado Pago reenviar mantendo o instante original, uma tolerância recusaria
  justamente os reenvios de que a API depende quando hiberna.
- *LGPD:* ao provedor vão o item "Consulta médica", o valor, uma referência
  aleatória e o prazo. Nada do paciente — verificado por teste que inspeciona o
  corpo enviado.
- *O checkout expira junto com a reserva*, e pedir de novo devolve o mesmo:
  dois checkouts abertos permitiriam pagar duas vezes. O banco garante um só
  aberto por consulta.
- *Motivo do cancelamento* passa a ser gravado — `paciente` ou
  `reserva_expirada` —, e o banco exige motivo em toda consulta cancelada.
  Para a análise de absenteísmo, desistir e abandonar o checkout são coisas
  diferentes.
- *Reconciliação antes de expirar:* no plano gratuito do Render a API hiberna e
  o aviso pode se perder; a rotina pergunta ao Mercado Pago antes de cancelar a
  consulta de quem talvez tenha pago.
- **Acrescentado durante a implementação:** um limite para o adiamento. Se o
  provedor estiver fora do ar, a expiração é adiada — mas, passados 30 minutos
  do vencimento, a reserva expira assim mesmo. Sem isso, uma queda longa do
  Mercado Pago prenderia horários indefinidamente.
- *Pagamento aprovado depois da expiração* não ressuscita a consulta — o
  horário pode ser de outra pessoa: vira anomalia registrada, para estorno.
- As duas pendências herdadas da Etapa 6 resolvidas: `liberar` passou a exigir o
  cliente de uma transação, e o desligamento trata a falha ao fechar o banco e
  tem prazo.

**Mais um teste verde que não provava nada — o sexto do trabalho, e o primeiro
previsto.** O teste que dispara webhook e expiração ao mesmo tempo passou seis
vezes seguidas com o `FOR UPDATE` removido: a ordem perigosa depende do acaso.
Foi substituído por um teste que **força** a ordem — abre a expiração pela
metade, lança o webhook, espera o próprio banco mostrar uma sessão aguardando
bloqueio (em `pg_stat_activity`) e só então confirma. Com o defeito, falha três
de três; sem ele, passa. O mesmo desenho, invertido, prova que a expiração não
cancela uma consulta paga no meio do caminho.

**Uma segunda rede, que ninguém planejou.** Com o bloqueio removido, quem
impediu a confirmação por cima do cancelamento foi a restrição criada para o
motivo de cancelamento: a consulta cancelada carregava `reserva_expirada`, e o
banco recusou deixá-la "confirmada" com esse motivo. O estado ficaria coerente
mesmo sem o bloqueio — mas por um erro 500 e um reenvio do Mercado Pago, e não
por projeto. O bloqueio continua sendo o mecanismo; a restrição, a rede.

**Um teste que falhava por acaso, escrito por mim.** Verificava que a
referência aleatória "não continha" o id da consulta — que vale 1 logo depois da
limpeza do banco, e um UUID contém o dígito 1 em cerca de 87% das vezes. Falhou
de forma intermitente durante a reintrodução de defeitos, e só por isso foi
notado. Passou a verificar o que importa: que a referência é um UUID aleatório.

Defeitos reintroduzidos, todos acusados: verificação de assinatura desligada,
conferência de valor desligada, pagamento em modo real aceito, bloqueio da
consulta removido no webhook, expiração sem reler o estado.

**370 testes passando**; teste de carga ainda 30 de 30 nas três fases.

**Pendente para a parte B**, que depende das contas: a terceira trava de
sandbox (recusar subir com credencial de conta real, se a API do Mercado Pago
permitir distinguir), e a validação da assinatura contra uma notificação real,
que substitui a documentação que não pôde ser lida.

---

## 19/09/2026 — Revisão local da parte A, e a API no GitHub

Revisão da parte A com dez achados, todos corrigidos. Uma ressalva de método
primeiro: os três revisores independentes que eu tinha disparado morreram no
limite de uso da conta, e a revisão acabou sendo feita só por mim — quem
escreveu o código revisando o próprio código, com os mesmos pontos cegos. Nas
etapas 6 e 7, foram justamente os revisores independentes que acharam o que eu
não tinha visto. Fica registrado como limitação desta revisão.

**O achado mais sério não era um defeito de código, e sim uma lacuna do
modelo.** Cancelar uma consulta JÁ PAGA encerrava o checkout aberto, devolvia o
horário e não dizia nada sobre o dinheiro recebido: a consulta sumia da agenda
e nenhum registro indicava que havia estorno a fazer. Agora cada pagamento
aprovado da consulta cancelada vira uma linha de auditoria
`pagamento.estorno_pendente`, na mesma transação. Estorno automático continua
fora do escopo; o que não podia é o caso ficar invisível.

**Duas afirmações minhas estavam erradas no texto.** O README dizia que "o
banco recusa pagamento fora do sandbox". Não recusa: a restrição do banco só
impede gravar a palavra 'producao' na coluna de ambiente, e nada no código
escreve outro valor ali. Quem de fato barra um pagamento real é a verificação
do webhook. O texto foi corrigido, e a restrição do banco passou a ser
descrita pelo que é — segunda linha de defesa contra escrita manual.

**O teste da trava aceitava qualquer sessão bloqueada.** Ele esperava o banco
mostrar *alguma* sessão parada aguardando bloqueio — o que outra execução da
suíte, ou uma conexão deixada para trás, satisfaria sozinha, liberando o teste
antes de o webhook chegar ao ponto crítico. Agora usa `pg_blocking_pids` e
exige que o bloqueado esteja travado **pela transação do próprio teste**. É o
mesmo tipo de fragilidade que já nos enganou seis vezes, desta vez pego antes
de enganar.

Outras correções: reversão de pagamento aprovado (estorno ou contestação)
passou a ser registrada como anomalia, em vez de mudar o status em silêncio; a
anomalia não é mais gravada de novo a cada reenvio da mesma notificação; o
checkout sem endereço de pagamento falha na hora, em vez de gravar um checkout
impagável; o tipo do evento no webhook passou a ser lido só da query, que é a
parte assinada; a subida avisa quando há credencial do Mercado Pago sem URL
pública; e o desligamento, que não tinha teste nenhum, ganhou um que sobe o
processo de verdade e manda SIGTERM — pulado no Windows, que não tem sinais
POSIX, e executado na integração contínua, que é Linux como o Render.

Cada correção foi confirmada reintroduzindo o defeito: cinco defeitos, sete
testes reprovados, nenhum outro.

**Primeira publicação no GitHub.** O repositório é público, como decidido. Antes
do envio, varredura do histórico inteiro: nenhuma credencial, nenhuma string de
conexão real — as duas ocorrências marcadas eram o nome do cabeçalho
`x-signature` no código e a senha `postgres` do banco descartável da integração
contínua. E a integração contínua, que existia desde a Etapa 3 e nunca tinha
rodado de verdade, passou de primeira nas duas branches — incluindo o teste de
carga da Seção 4.5 contra um PostgreSQL local, um regime bem diferente do
nosso.

O serviço do Render passou a ser descrito no próprio repositório
(`render.yaml`), sem segredo nenhum: as sete variáveis sensíveis são pedidas no
painel. Região Virginia, porque o plano gratuito não tem região no Brasil — cada
ida ao banco em São Paulo passa a custar por volta de 120 ms, contra 56 ms
medidos localmente, e isso precisa constar do capítulo de resultados.

**378 testes passando**, um pulado no Windows.

---

## 19–20/09/2026 — A primeira ligação real com o Mercado Pago derruba uma trava

Primeira conversa da API com o Mercado Pago de verdade, ainda sem publicar
nada: criar preferência e buscar pagamento são chamadas de saída, que funcionam
de qualquer máquina. Escrevi um verificador (`npm run verificar:sandbox`) para
isso — a suíte usa `fetch` falso e prova o que o adaptador ENVIA, não o que o
provedor aceita.

O checkout abriu com "Consulta médica — R$ 180,50" e mais nada: a minimização
prometida no projeto, agora visível na tela do provedor. Paguei com a conta de
teste compradora e um cartão de teste. Aprovado. E então:

    modo real ... true
    ✗ é pagamento de sandbox, não real

**A trava de sandbox do domínio estava errada desde a concepção.** Ela recusava
pagamento com `live_mode` verdadeiro, supondo que "modo real" e "fora do
sandbox" fossem a mesma coisa. Não são: uma conta de teste do Mercado Pago é
uma conta comum operando em **modo produção** — o que é falso é a conta, não o
modo. Dinheiro fictício, cartão fictício, `live_mode: true`. Em produção,
aquela verificação recusaria todos os pagamentos do trabalho, e nenhuma
consulta seria confirmada. Pior: como conta real também devolve verdadeiro, o
campo não distinguia o caso perigoso de jeito nenhum. Uma trava que barra o
legítimo e não barra o perigoso é pior que trava nenhuma, porque dá a
impressão de que o problema está resolvido.

Vale reparar em como isso apareceu. Não foi um teste da suíte: nenhum teste com
dublê poderia ter pego, porque o dublê devolvia `modoReal: false` — eu escrevi
o dublê com a suposição errada embutida. **O que pegou foi uma verificação
contra o serviço real, feita antes de publicar.** É o mesmo papel que o teste
de token real do Firebase cumpriu na Etapa 5. Fica a regra: toda suposição
sobre o comportamento de um sistema externo é hipótese até ser conferida contra
ele; o dublê propaga a suposição, não a testa.

**A proteção mudou de lugar e ficou mais forte.** A API agora pergunta ao
Mercado Pago, na subida, de quem é a credencial (`GET /users/me`) e só abre a
porta se a conta tiver a marca `test_user`, que é o provedor quem põe. Recusa
antes de existir qualquer cobrança, em vez de depois de o cartão de alguém já
ter sido debitado. Falha fechada: se o provedor não responde, a API não sobe —
"não consegui verificar" não é "está tudo bem", e esta é a única coisa entre o
trabalho e o dinheiro de um participante de pesquisa. Para desenvolver sem
rede, basta tirar a credencial do `.env`.

`descreverConta` entrou no **contrato** do gateway, e não só no adaptador: a
restrição a sandbox é exigência do trabalho, não detalhe de implementação, e
nenhum provedor deve poder ser ligado a esta API sem saber responder se o
dinheiro que move é de verdade.

**Uma proteção da revisão anterior foi removida, de propósito.** Com o modo
real fora do caminho, toda anomalia passou a vir acompanhada de gravação do
pagamento, e o reenvio da mesma notificação sai antes, no
`statusAnterior === status` do domínio. A conferência de auditoria repetida
ficou sem nenhum caminho que a alcançasse. Código que nenhum teste consegue
derrubar não se mantém "por garantia" — foi removido, e o teste que o cobria
passou a exercer a proteção que de fato existe.

**Um buraco que eu mesmo abri, e fechei.** A decisão da trava tinha teste de
unidade, mas nada provava que o `servidor.js` a chamava: apagar a verificação
de lá não derrubaria teste nenhum. Agora um teste de integração sobe o processo
de verdade com credencial inválida e exige que a porta não abra. Ao escrevê-lo,
apareceu um defeito real: `process.exit` com o soquete do provedor ainda aberto
produz asserção do libuv no Windows e código de saída 0xC0000409 no lugar de 1
— a mensagem de erro fica escondida atrás de um estouro. Corrigido nos dois
pontos de saída da subida.

Confirmação por reintrodução, em três rodadas: aceitar conta sem a marca
derruba dois testes do adaptador; ignorar o veredito derruba o da conta real;
falhar aberto quando o provedor não responde derruba os dois de falha fechada
mais o de integração; e tirar a chamada do `servidor.js` derruba só o de
integração, que ficou trinta segundos de pé até o `SIGKILL` — porque a API
subiu, que é exatamente o que ele existe para impedir. 389 testes.
