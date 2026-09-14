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
| Runtime | Node.js 20+ |
| HTTP | Express |
| Banco | PostgreSQL (Neon) |
| Validação | Zod |
| Migrations | node-pg-migrate |
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

Pré-requisitos: Node.js 20 ou superior e uma conta no [Neon](https://neon.tech)
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
| 403 | O recurso pertence a outro paciente |
| 404 | Não existe |
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

Há ainda uma segunda defesa, no próprio banco: o índice único parcial
`consulta_horario_ativo` impede duas consultas ativas no mesmo horário mesmo que
algum caminho futuro esqueça de comparar a versão. Ele é *parcial* — ignora
consultas canceladas — porque um horário cancelado precisa voltar a ser
agendável, enquanto o registro do cancelamento permanece para o histórico.

## Licença

MIT.
