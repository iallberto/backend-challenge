# Research: Distributed Wagering Processor

Fase 0 do `/speckit-plan`. Cada item: **Decisão**, **Por quê**, **Alternativas consideradas**.
As decisões de negócio já tomadas estão na spec (Clarifications, FR-048a, FR-049, FR-050); aqui
ficam as decisões de **como**.

---

## R1. Runtime e framework: Bun 1.x + NestJS 11 + TypeScript estrito

- **Decisão**: Bun como runtime, gerenciador de pacotes e test runner; NestJS 11 com adapter
  Express; `tsconfig` com `strict`, `noUncheckedIndexedAccess`, `experimentalDecorators` e
  `emitDecoratorMetadata`.
- **Por quê**: stack obrigatória. A injeção de dependência do NestJS depende de metadata de
  decorators, que o Bun suporta via `tsconfig`.
- **Risco**: compatibilidade Bun × NestJS × MikroORM. **Mitigação**: a primeira tarefa da
  implementação é um *spike* que sobe o app, conecta no Postgres e roda uma migration no Bun.
- **Alternativas**: Fastify adapter (mais rápido, mas mais um ponto de incompatibilidade com Bun
  sem ganho relevante para o desafio).

## R2. ORM: MikroORM 6 com modelos de persistência separados do domínio

- **Decisão**: MikroORM 6 (`@mikro-orm/postgresql`), mapeamento por `EntitySchema` (sem
  decorators) em classes de persistência (`WalletRecord`, `WagerTransactionRecord`, …) dentro de
  `infrastructure/`. Repositórios convertem `Record ↔ domínio` por mappers que chamam
  `Domain.rehydrate(...)`. Transações por `em.transactional()`. Migrations com
  `@mikro-orm/migrations`, sempre com `up` e `down`.
- **Por quê**:
  - É o ORM preferencial do desafio (Unit of Work, Identity Map, `LockMode`).
  - O domínio não pode depender do ORM (Constituição VI). Se o MikroORM hidratasse as classes de
    domínio diretamente, ele pularia o construtor privado e a factory `rehydrate`, e os tipos do
    ORM vazariam para o domínio.
  - O mapper deixa explícito o único lugar onde `Money` vira `NUMERIC` e vice-versa.
- **Trade-off**: duas classes por agregado e código de mapeamento. Aceito porque é mecânico,
  testável e mantém o domínio puro.
- **Alternativas**: TypeORM (aceito, mas sem Unit of Work explícito); mapear o domínio direto
  com decorators (mais curto, viola a separação).

## R3. Money: `bigint` em centavos internamente, `NUMERIC(19,2)` no banco, string nos contratos

- **Decisão**:
  - `Money` guarda o valor como `bigint` de unidades mínimas (centavos) + `currency`.
  - Entrada aceita somente `^(0|[1-9]\d*)(\.\d{1,2})?$` (ex.: `"25"`, `"25.5"`, `"25.50"`) e
    normaliza para 2 casas. Rejeita `NaN`, `Infinity`, notação científica, sinal, vazio, mais de
    2 casas e zeros à esquerda.
  - Serialização sempre com 2 casas (`"25.50"`).
  - No banco: `NUMERIC(19,2)` + coluna `currency CHAR(3)`. Conversão só no mapper, via string.
  - Moeda: código ISO-4217 de 3 letras maiúsculas; escala fixa de 2 para todas (premissa do desafio).
- **Por quê**: `bigint` é exato, nativo, sem dependência e sem arredondamento: soma e subtração
  de inteiros não perdem precisão. Como o desafio fixa 2 casas e não há multiplicação nem
  divisão, uma biblioteca decimal seria peso morto. `NUMERIC` no banco mantém os valores
  legíveis e permite `CHECK (balance >= 0)`.
- **Alternativas**: `decimal.js`/`big.js` (corretos, mas desnecessários sem divisão);
  `BIGINT` em centavos no banco (exato, mas menos legível em auditoria e consultas manuais).

## R4. Concorrência: lock pessimista por wallet (`SELECT … FOR UPDATE`)

- **Decisão**: todo caso de uso que altera saldo abre uma transação `READ COMMITTED`, trava a
  linha da wallet com `SELECT … FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`) **antes** de ler o
  estado e decidir, e só então grava. `version` continua incrementando quando o saldo muda
  (exigência da spec), servindo de auditoria e de ordenação para consumidores de eventos.
  `lock_timeout` de 5 s por transação: se estourar, vira falha transitória (503 ou retry da fila)
  e incrementa a métrica de conflitos de lock.
- **Por quê**:
  - O lock é na **linha** da wallet: serializa só operações da mesma wallet; wallets diferentes
    seguem em paralelo (sem lock global, Constituição IV).
  - Vale entre instâncias porque o lock vive no Postgres compartilhado.
  - No cenário de "hot wallet" (50 requisições paralelas), o otimista gera uma tempestade de
    retries: só uma vence por rodada. O pessimista forma uma fila ordenada, sem retries.
  - Cada transação trava **uma única** wallet, então não há risco de deadlock por ordem de locks.
  - `CHECK (balance >= 0)` no schema é a última linha de defesa.
- **Alternativas**:
  - Otimista com `version` + retry limitado: bom com baixa disputa, ruim com hot wallet.
  - `UPDATE … SET balance = balance - x WHERE balance >= x`: muito eficiente, mas dificulta
    gravar `balance_before`/`balance_after` e aplicar regras de domínio antes da escrita.

## R5. Idempotência: lock + verificação + constraints únicas como guarda final

- **Decisão**: fluxo do caso de uso `SubmitWagerTransaction`:
  1. Validar payload e calcular `payloadHash`.
  2. Abrir transação; travar a wallet (`FOR UPDATE`).
  3. Buscar transação por `idempotency_key`:
     - existe com mesmo hash → **replay** (devolve o resultado gravado);
     - existe com hash diferente → **conflito de idempotência**.
  4. Buscar por `(provider_id, external_transaction_id)`: existe com outra chave → **conflito**
     (FR-028a).
  5. Aplicar regras, gravar transação + ledger + wallet + outbox (+ inbox) e fazer commit.
  6. Se o commit falhar com violação de unicidade (`23505`) em `idempotency_key` ou
     `(provider_id, external_transaction_id)`, desfazer e **reler fora da transação** para
     devolver replay ou conflito.
- **Por quê**: o lock da wallet já serializa duplicatas da mesma wallet, então o passo 3 resolve
  o caso comum (ex.: 50 BETs idênticas). As constraints únicas cobrem o caso em que a mesma chave
  chega com `walletId` diferente (locks em wallets diferentes) e qualquer bug de código.
- **Resultado do replay**: a transação guarda `result_balance` e `result_wallet_version`
  (saldo observado na decisão), para devolver exatamente a resposta original (FR-026).
- **Alternativas**: tabela separada de chaves de idempotência (redundante, porque a transação
  já é única por chave); `INSERT … ON CONFLICT` antes do lock (complica o replay de quem perdeu
  a corrida enquanto o vencedor ainda não commitou).

## R6. `payloadHash`: SHA-256 de JSON canônico dos campos de negócio

- **Decisão**: `sha256(hex)` sobre um JSON com **chaves ordenadas**, sem espaços, contendo
  apenas: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`,
  `kind`, `money.amount` (já normalizado para 2 casas), `money.currency` e
  `referenceExternalTransactionId` (ou `null`). Header, `messageId`, `occurredAt` e
  `idempotencyKey` ficam fora.
- **Por quê**: o mesmo conteúdo de negócio, por HTTP ou por fila, com campos em outra ordem ou
  `"25"` versus `"25.00"`, gera o mesmo hash. Isso implementa a canonicalização do estilo
  RFC 8785 (JCS) de forma simples, porque os valores são todos strings ou `null`.
- **Alternativas**: hash do corpo cru (quebra com espaços ou ordem diferentes); incluir
  metadados de transporte (o mesmo negócio pela fila e pelo HTTP viraria conflito).

## R7. Inbox: linha `(consumer_name, message_id)` na mesma transação

- **Decisão**: o consumidor SQS chama o mesmo caso de uso, passando o contexto de inbox. Dentro
  da transação, o primeiro passo é `INSERT INTO inbox_message … ON CONFLICT DO NOTHING`. Se nada
  foi inserido, a mensagem já foi tratada: commit vazio e ack.
- **Por quê**: inbox deduplica o **transporte** (mesmo `messageId` reentregue); a idempotency key
  deduplica o **negócio** (mesma operação com outro `messageId`). São camadas complementares.
  Estando na mesma transação, não existe "inbox gravado e efeito perdido".
- **Alternativas**: confiar só na idempotency key (funciona, mas a spec e a avaliação pedem inbox
  persistente explícito); deduplicação do SQS FIFO (janela de 5 min, não é garantia).

## R8. Outbox: `FOR UPDATE SKIP LOCKED` em lotes curtos

- **Decisão**: o worker `OutboxPublisher` roda em toda instância, em ciclos de ~500 ms:
  1. Transação curta: `SELECT … FROM outbox_message WHERE published_at IS NULL AND
     next_attempt_at <= now() ORDER BY occurred_at LIMIT 10 FOR UPDATE SKIP LOCKED`.
  2. Publica cada evento no SQS (`wagering-events.fifo`, `MessageGroupId = aggregateId`,
     `MessageDeduplicationId = eventId`).
  3. Sucesso → `published_at = now()`; falha → `attempts + 1` e `next_attempt_at` com backoff
     (base 1 s, teto 60 s, com jitter).
  4. Commit.
- **Por quê**:
  - `SKIP LOCKED` faz publishers concorrentes pegarem lotes diferentes sem esperar.
  - Se o processo morrer no meio, a transação é desfeita, o lock é liberado e outra instância
    pega o lote: nada se perde.
  - Se morrer **depois** de publicar e **antes** do commit, o evento sai de novo, com o mesmo
    `eventId`. É o at-least-once previsto; o consumidor deduplica por `eventId`.
- **Ordenação**: dois publishers podem publicar eventos da mesma wallet fora de ordem.
  Consumidores devem usar `walletVersion` (em `WalletBalanceChanged`) para ordenar. Fica
  documentado como trade-off.
- **Alternativas**: lease com coluna `locked_until` (permite publicar fora da transação, mas tem
  mais estados para errar); CDC/Debezium (fora do escopo).

## R9. Consumidor SQS

- **Decisão**:
  - Long polling (`WaitTimeSeconds = 20`, até 10 mensagens), visibility timeout de 30 s.
  - Fila de entrada `wager-transactions.fifo` com redrive para `wager-transactions-dlq.fifo`,
    `maxReceiveCount = 5`.
  - Classificação do resultado (FR-032, FR-032a, FR-032b):

    | Resultado | Ação na mensagem |
    |---|---|
    | Processada, rejeitada, aguardando referência, replay | `DeleteMessage` (ack) |
    | Payload inválido (validável) | ack + log + métrica (reenviar não resolve) |
    | Falha transitória (banco, lock timeout) | sem ack; `ChangeMessageVisibility` com backoff |
    | Falha permanente, banco acessível | grava `FAILED` + evento, ack |
    | Mensagem ilegível / banco inacessível | sem ack; após 5 recebimentos vai para a DLQ |

  - `SIGTERM`: para de buscar mensagens, espera as que estão em andamento por até 20 s
    (menos que o visibility timeout) e devolve as restantes com
    `ChangeMessageVisibility(0)`.
- **Por quê**: ack só depois do commit (Constituição V). O visibility timeout é o mecanismo
  natural de crash recovery: mensagem sem ack reaparece sozinha.
- **Trade-off FIFO**: a ordem por `MessageGroupId` (= `walletId`) faz uma mensagem em retry
  bloquear as seguintes da mesma wallet (*head-of-line blocking*). É aceitável porque a ordem por
  wallet reduz `PENDING_REFERENCE`, mas o banco continua sendo a garantia.

## R10. Worker de `PENDING_REFERENCE`

- **Decisão**: o worker `PendingReferenceWorker` roda em toda instância, a cada 1 s. Seleciona
  `status = 'PENDING_REFERENCE' AND next_attempt_at <= now()` com `FOR UPDATE SKIP LOCKED`
  (lote de 20) e reprocessa pelo mesmo caso de uso, em modo reprocessamento. Backoff: base 1 s,
  teto 5 min, jitter de ±20 %, prazo `expires_at = created_at + 1 h`, todos por variáveis de
  ambiente.
- Ao reprocessar: referência processada → aplica; referência terminal não processada →
  `REFERENCE_NOT_PROCESSED`; ausente e `now() >= expires_at` → `REFERENCE_NOT_FOUND` + evento;
  ausente dentro do prazo → reagenda.
- **Por quê**: o mesmo padrão `SKIP LOCKED` da outbox, sem coordenação entre instâncias.

## R11. Invariantes no schema (Constituição II)

- **Decisão** (detalhes em [data-model.md](./data-model.md)):
  - `UNIQUE (player_id, currency)` em `wallet`; `CHECK (balance >= 0)`; `CHECK (version >= 1)`.
  - `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` em
    `wager_transaction`.
  - Índice único parcial de reversão (FR-049):
    `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
  - `wallet_ledger_entry`: `UNIQUE (transaction_id, wallet_id)`; `CHECK` da aritmética
    (`balance_after = balance_before ± amount`); `CHECK (balance_after >= 0)`; trigger que
    bloqueia `UPDATE`, `DELETE` e `TRUNCATE`.
  - `wager_transaction`: trigger que impede sair de estado terminal e alterar campos de negócio.
- **Por quê**: o código é a primeira defesa; o banco é a garantia que nenhuma corrida contorna.
- **Alternativa**: `REVOKE UPDATE, DELETE` para o papel da aplicação (complementar; o trigger
  vale até para o dono das tabelas).

## R12. Identificadores e paginação

- **Decisão**: IDs internos UUIDv7 (`Bun.randomUUIDv7()`), compatíveis com os exemplos do README
  e ordenáveis por tempo. O ledger tem também `seq BIGINT GENERATED ALWAYS AS IDENTITY`; o cursor
  do extrato é `base64url(seq)`, com ordenação por `seq` e keyset pagination
  (`WHERE wallet_id = $1 AND seq > $cursor ORDER BY seq LIMIT $n`).
- **Por quê**: o keyset por uma sequência do banco é estável: novos lançamentos entram no fim e
  não causam repetição nem lacuna. Offset pagination falharia nesse caso. Um cursor opaco
  permite mudar a implementação sem quebrar clientes.

## R13. Validação da entrada HTTP: zod

- **Decisão**: schemas `zod` nos DTOs de borda (HTTP e mensagem SQS); regras monetárias e de
  domínio ficam em `Money` e nos agregados.
- **Por quê**: a mesma validação serve aos dois canais, com tipos inferidos e sem depender de
  metadata de decorators (menos risco com Bun).
- **Alternativas**: `class-validator` (padrão do Nest, mas depende de reflection e de classes).

## R14. Observabilidade

- **Decisão**:
  - Logs: `pino` em JSON, com contexto por `AsyncLocalStorage` (`correlationId`, `messageId`,
    `transactionId`, `walletId`, `providerId`); sem valores monetários completos nem payload.
    `correlationId` vem do header `X-Correlation-Id` ou da mensagem; se não vier, é gerado.
  - Métricas: `prom-client` em `GET /metrics`:
    `wager_transactions_total{status,kind}`, `idempotency_duplicates_total{channel}`,
    `retries_total{component}`, `dlq_messages` (gauge, via `GetQueueAttributes`),
    `wallet_lock_conflicts_total`, `outbox_lag_seconds` (idade do evento pendente mais antigo),
    `processing_duration_seconds` (histograma), `reconciliation_divergences_total`.
  - Health: `GET /health/live` (processo responde) e `GET /health/ready` (`SELECT 1` +
    `GetQueueAttributes`), ambos abertos.
- **Alternativas**: OpenTelemetry completo (opcional; fica como evolução).

## R15. Identidade do provedor (decisão Q1)

- **Decisão**: porta `ProviderIdentityPort.resolve(request): ProviderIdentity`. Adaptador
  `DevHeaderProviderIdentity` lê `X-Provider-Id` e é marcado como inseguro. O caso de uso compara
  a identidade com `providerId` do payload **antes** da idempotência e devolve
  `PROVIDER_MISMATCH` (403) se forem diferentes, sem gravar nada. Gravar a recusa permitiria a um
  provedor bloquear chaves de outro (o replay devolveria a rejeição ao dono legítimo). Na fila (canal interno confiável), a identidade é o próprio `providerId` da
  mensagem, mas o conteúdo passa pelas mesmas validações.
- **Evolução documentada**: adaptador `JwtProviderIdentity` (Keycloak, client credentials,
  validação via JWKS, `azp`/`client_id` = providerId).

## R16. Estratégia de testes

- **Decisão**:
  - `bun test` para tudo.
  - Unidade: domínio puro (`Money`, `Wallet`, `WagerTransaction`, ledger, regras por kind,
    hash canônico), sem infraestrutura.
  - Integração e concorrência: PostgreSQL e LocalStack reais via `docker compose`; cada teste
    cria as próprias wallets (UUID novo), sem depender de ordem.
  - Multi-instância: o teste sobe **3 processos** da aplicação com `Bun.spawn` (portas
    diferentes, mesmo banco e mesma fila) e dispara requisições e mensagens em paralelo real.
  - Falhas determinísticas: ganchos de injeção de falha ativados só por variável de ambiente em
    teste (`FAULT_INJECTION=crash_after_commit_before_ack`, `crash_after_commit_before_publish`),
    que matam o processo com `process.exit(137)` exatamente naquele ponto.
  - Invariante final em todo teste que movimenta saldo: reconciliação com diferença zero.
- **Por quê**: corridas só aparecem com paralelismo e infraestrutura reais (Constituição VII);
  os ganchos tornam os cenários de queda reproduzíveis, em vez de depender de sorte de timing.
- **Alternativas**: Testcontainers (bom, mas a compatibilidade com Bun é incerta; o compose já é
  exigido pelo desafio).

## R17. Infraestrutura local

- **Decisão**: `docker-compose.yml` com `postgres:16`, `localstack/localstack` (serviço SQS) com
  script de init que cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive,
  `maxReceiveCount = 5`) e `wagering-events.fifo`, e o serviço `app`, escalável com
  `docker compose up --scale app=3`.
- **Por quê**: comando único de setup; o escalonamento demonstra multi-instância também fora
  dos testes.
