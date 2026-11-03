---

description: "Task list for the Distributed Wagering Processor"
---

# Tasks: Distributed Wagering Processor

**Input**: Design documents from `specs/001-distributed-wagering-processor/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: OBRIGATÓRIOS. O desafio (README §13) e a Constituição VII exigem testes de unidade,
de integração com Postgres e LocalStack reais, e de concorrência com paralelismo real. Em cada
história, os testes vêm antes da implementação e devem falhar primeiro.

**Organization**: tarefas agrupadas por história de usuário; cada história é testável sozinha
depois da Fase 2.

**Status (2026-11-03)**: 107 de 109 tarefas concluídas; 137 testes passando. Pendentes: T007 (lint
e formatação não configurados) e T109 (adaptador JWT/Keycloak, opcional; desenho em
`ARCHITECTURE.md` §9). Na implementação, alguns arquivos foram consolidados com nomes diferentes
dos previstos aqui (ex.: testes de concorrência em `tests/concurrency/races.test.ts` e
`crash-recovery.test.ts`); o mapeamento exigência → teste está no `README.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência de tarefa incompleta)
- **[Story]**: história da spec (US1…US9)
- Todo teste que movimenta saldo termina verificando `saldo == saldo reconstruído pelo ledger`
  com o helper de T030

## Path Conventions

Projeto único: `src/` e `tests/` na raiz (ver [plan.md](./plan.md#project-structure)).

---

## Phase 1: Setup (infraestrutura do projeto)

**Purpose**: projeto rodando no Bun, com Postgres e LocalStack no Compose.

- [x] T001 Criar `package.json` com Bun, scripts (`start`, `test`, `test:unit`, `test:integration`, `test:concurrency`, `test:load`, `migration:up`, `migration:down`, `migration:create`) e dependências do plan.md
- [x] T002 Criar `tsconfig.json` com `strict`, `noUncheckedIndexedAccess`, `experimentalDecorators`, `emitDecoratorMetadata` e paths `@domain/*`, `@application/*`, `@infrastructure/*`, `@interfaces/*`
- [x] T003 [P] Criar `docker-compose.yml` com `postgres:16`, `localstack/localstack` (SQS) e serviço `app` escalável
- [x] T004 [P] Criar `docker/localstack/init-sqs.sh` criando `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive `maxReceiveCount = 5`) e `wagering-events.fifo`
- [x] T005 [P] Criar `Dockerfile` da aplicação em Bun
- [x] T006 [P] Criar `.env.example` com `DATABASE_URL`, `SQS_ENDPOINT`, filas, `LOCK_TIMEOUT_MS`, backoff/TTL de pendentes, backoff da outbox e `FAULT_INJECTION`
- [ ] T007 [P] Configurar lint e formatação (`biome.json`) e `.gitignore`
- [x] T008 **Spike de compatibilidade**: `src/main.ts` + `src/app.module.ts` mínimos subindo NestJS no Bun, conectando no Postgres com MikroORM e rodando uma migration vazia (risco R1). Registrar o resultado em `ARCHITECTURE.md`

**Checkpoint**: `docker compose up -d` + `bun run start` sobem sem erro.

---

## Phase 2: Foundational (bloqueia todas as histórias)

**Purpose**: domínio base, schema completo, persistência, transação, observabilidade e
infraestrutura de testes.

**⚠️ CRITICAL**: nenhuma história começa antes desta fase.

### Domínio base

- [x] T009 [P] Testes de `Money` em `tests/unit/domain/money.test.ts`: formatos aceitos e rejeitados (R3), normalização para 2 casas, limite de 17 dígitos inteiros, soma, subtração, `negate`, comparações, imutabilidade, conflito de moeda
- [x] T010 [P] `DomainError` e erros base em `src/domain/shared/errors.ts`
- [x] T011 Implementar `Money` (bigint em centavos) em `src/domain/money/money.ts`
- [x] T012 [P] `FailureCode` (enum da taxonomia de [failure-codes.md](./contracts/failure-codes.md)) em `src/domain/wagering/failure-code.ts`
- [x] T013 [P] Enums `WagerTransactionKind`, `WagerTransactionStatus` e `LedgerDirection` em `src/domain/wagering/enums.ts`
- [x] T014 [P] Testes de `WalletLedgerEntry` em `tests/unit/domain/ledger-entry.test.ts` (aritmética validada na factory, moeda, ausência de mutação)
- [x] T015 Implementar `WalletLedgerEntry` em `src/domain/wallet/wallet-ledger-entry.ts`
- [x] T016 [P] Classe abstrata `IntegrationEvent<T>` e `EventContext` em `src/domain/events/integration-event.ts`
- [x] T017 [P] Subclasses de evento (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionFailed`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) em `src/domain/events/`
- [x] T018 [P] Testes de `OutboxMessage` e `InboxMessage` em `tests/unit/domain/messaging.test.ts` (`enqueue`, `isDue`, `scheduleRetry` com teto e jitter, `markPublished`)
- [x] T019 Implementar `OutboxMessage` e `InboxMessage` em `src/domain/messaging/`

### Schema (todas as tabelas e invariantes de [data-model.md §2](./data-model.md#2-schema-postgresql))

- [x] T020 Configurar MikroORM em `src/infrastructure/persistence/mikro-orm.config.ts` (Postgres, migrations com `up`/`down`, `lock_timeout` por transação)
- [x] T021 Migration `wallet` com `UNIQUE (player_id, currency)`, `CHECK (balance >= 0)`, `CHECK (version >= 1)` em `src/infrastructure/persistence/migrations/`
- [x] T022 Migration `wager_transaction` com as duas unicidades, os `CHECK`s de status/referência/valor, o índice parcial `ux_reversal_once`, os índices de pendentes e os triggers de estado terminal, campos imutáveis e bloqueio de `DELETE`
- [x] T023 Migration `wallet_ledger_entry` com `seq` identity, `UNIQUE (transaction_id, wallet_id)`, `CHECK` aritmético, `CHECK (balance_after >= 0)` e triggers que bloqueiam `UPDATE`/`DELETE`/`TRUNCATE`
- [x] T024 Migration `inbox_message` e `outbox_message` com o índice `ix_outbox_due`
- [x] T025 Testes de integração do schema em `tests/integration/schema.test.ts`: `up` e `down` de todas as migrations, e cada constraint/trigger rejeitando escrita inválida direto via SQL

### Persistência e aplicação base

- [x] T026 [P] Portas em `src/application/ports/` (`UnitOfWork`, `WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `InboxRepository`, `OutboxRepository`, `ProviderIdentityPort`, `Clock`, `IdGenerator`)
- [x] T027 [P] `EntitySchema` dos records em `src/infrastructure/persistence/schemas/`
- [x] T028 Mappers `Record ↔ domínio` (via `rehydrate`) e conversão `Money ↔ NUMERIC` em `src/infrastructure/persistence/mappers/`
- [x] T029 `MikroOrmUnitOfWork` com `em.transactional()`, `SELECT … FOR UPDATE` da wallet e tradução de `23505`/`55P03` (lock timeout) em erros de aplicação em `src/infrastructure/persistence/unit-of-work.ts`
- [x] T030 [P] Infra de testes em `tests/support/`: conexão com Postgres/LocalStack, limpeza, fábrica de wallets, cliente HTTP, `assertReconciled(walletId)` (saldo == ledger via SQL) e `spawnInstances(n)` com `Bun.spawn`
- [x] T031 [P] `UuidV7IdGenerator` e `SystemClock` em `src/infrastructure/`

### Borda HTTP e observabilidade base

- [x] T032 [P] Logger `pino` JSON e contexto de correlação com `AsyncLocalStorage` em `src/infrastructure/observability/` (campos `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; sem valores monetários)
- [x] T033 [P] Registro de métricas `prom-client` com todos os contadores, gauges e histogramas do R14 em `src/infrastructure/observability/metrics.ts`
- [x] T034 Mapeamento de resultados e erros para HTTP em `src/interfaces/http/error-mapping.ts` conforme [failure-codes.md](./contracts/failure-codes.md), com testes em `tests/unit/http/error-mapping.test.ts`
- [x] T035 [P] `DevHeaderProviderIdentity` (header `X-Provider-Id`, marcado como inseguro) em `src/infrastructure/identity/dev-header-provider-identity.ts`
- [x] T036 [P] Ganchos de injeção de falha controlados por `FAULT_INJECTION` em `src/infrastructure/fault-injection/fault-injection.ts` (no-op fora de teste): `crash_after_commit_before_ack`, `crash_after_commit_before_publish` e `permanent_error_in_use_case`

**Checkpoint**: schema completo testado, domínio base testado, app sobe com logs e métricas.

---

## Phase 3: User Story 1 — Abrir carteira com saldo inicial (P1) 🎯 MVP

**Goal**: criar wallet com crédito `OPENING` auditável na mesma transação.

**Independent Test**: abrir com `1000.00` → saldo, versão 1, um crédito no extrato; abrir de novo
→ 409.

### Tests

- [x] T037 [P] [US1] Testes de `Wallet.open` em `tests/unit/domain/wallet-open.test.ts` (saldo zero sem lançamento, saldo positivo com `OPENING`, versão 1)
- [x] T038 [P] [US1] Integração de `POST /wallets` em `tests/integration/open-wallet.test.ts` (201, 409 `WALLET_ALREADY_EXISTS`, 400 `INVALID_MONEY`, atomicidade wallet + transação + ledger + outbox, `assertReconciled`)
- [x] T039 [P] [US1] Concorrência em `tests/concurrency/open-wallet-race.test.ts`: 20 aberturas paralelas para o mesmo jogador + moeda → exatamente uma wallet

### Implementation

- [x] T040 [US1] `Wallet` (aggregate root) com `open`, `rehydrate`, `credit`, `debit` e `version` em `src/domain/wallet/wallet.ts`
- [x] T041 [US1] `WalletRepository` MikroORM em `src/infrastructure/persistence/repositories/wallet.repository.ts`
- [x] T042 [US1] Caso de uso `OpenWallet` em `src/application/use-cases/open-wallet.ts`
- [x] T043 [US1] DTO zod e `WalletsController` (`POST /wallets`) em `src/interfaces/http/`

**Checkpoint**: US1 funcional e testada sozinha.

---

## Phase 4: User Story 2 — Debitar aposta com segurança (P1)

**Goal**: BET debita ou rejeita, sem lost update, com 3 instâncias.

**Independent Test**: cenário 100/80/80 da spec (SC-002).

### Tests

- [x] T044 [P] [US2] Testes de `WagerTransaction` (create, transições, terminais lançando `InvalidTransactionStateError`, `affectsBalance`, `requiresReference`) em `tests/unit/domain/wager-transaction.test.ts`
- [x] T045 [P] [US2] Testes de regras de BET em `tests/unit/application/bet-rules.test.ts` (saldo insuficiente, moeda, wallet de outro jogador, `PROVIDER_MISMATCH`)
- [x] T046 [P] [US2] Integração de `POST /wagering/transactions` para BET em `tests/integration/bet.test.ts` (201, 422 com `failureCode`, 403 sem persistência, rejeição sem ledger e **sem mudar `version`**, BET de `0.00` → 400 `INVALID_MONEY` sem gravação, `OPENING` → 400 `OPENING_NOT_ALLOWED`, `permanent_error_in_use_case` → 500 + transação `FAILED` + evento, atomicidade, `assertReconciled`)
- [x] T047 [P] [US2] Concorrência em `tests/concurrency/hot-wallet.test.ts`: saldo 100, duas BETs de 80 em paralelo → uma `PROCESSED`, uma `INSUFFICIENT_FUNDS`, saldo 20, um débito; e, com `LOCK_TIMEOUT_MS` baixo e a wallet travada por outra conexão, a requisição recebe 503 sem efeito e `wallet_lock_conflicts_total` incrementa
- [x] T048 [P] [US2] Concorrência em `tests/concurrency/parallel-wallets.test.ts`: 10 wallets × 20 operações em paralelo terminam em menos de 3× o tempo de 1 wallet × 20 operações (SC-009)
- [x] T049 [P] [US2] Concorrência em `tests/concurrency/multi-instance.test.ts`: 3 processos (`spawnInstances(3)`) disputando a mesma wallet → sem saldo negativo, sem débito duplicado, reconciliação zero

### Implementation

- [x] T050 [US2] `WagerTransaction` com factories, transições e consultas de domínio em `src/domain/wagering/wager-transaction.ts`
- [x] T051 [US2] `WagerTransactionRepository` e `LedgerRepository` em `src/infrastructure/persistence/repositories/`
- [x] T052 [US2] Caso de uso `SubmitWagerTransaction` (validação na ordem de data-model §1.3, lock da wallet, BET, gravação + outbox; erro permanente não-negocial → desfaz e grava `FAILED` + `WagerTransactionFailed` em nova transação, quando o banco estiver acessível, FR-032a) em `src/application/use-cases/submit-wager-transaction.ts`
- [x] T053 [US2] DTO zod e `WageringController` (`POST /wagering/transactions`) em `src/interfaces/http/`
- [x] T054 [US2] Métricas `wager_transactions_total`, `processing_duration_seconds` e `wallet_lock_conflicts_total` no caso de uso

**Checkpoint**: BET correta sob concorrência e com várias instâncias.

---

## Phase 5: User Story 3 — Reenvio sem efeito duplicado (P1)

**Goal**: idempotência persistente com replay fiel e conflitos.

**Independent Test**: mesma BET 50× em paralelo → um débito (SC-001).

### Tests

- [x] T055 [P] [US3] Testes do hash canônico em `tests/unit/application/payload-hash.test.ts` (ordem de chaves, `"25"` = `"25.00"`, metadados fora do hash)
- [x] T056 [P] [US3] Integração em `tests/integration/idempotency.test.ts`: replay com o mesmo código e o saldo da época, replay de rejeição (422), 409 `IDEMPOTENCY_KEY_CONFLICT`, 409 `EXTERNAL_ID_CONFLICT`, replay após reinício do processo
- [x] T057 [P] [US3] Concorrência em `tests/concurrency/same-bet-50x.test.ts`: 50 requisições idênticas em paralelo → um débito, 49 replays
- [x] T058 [P] [US3] Concorrência em `tests/concurrency/same-key-different-wallet.test.ts`: mesma chave com `walletId` diferente em paralelo → um efeito, o outro conflito (guarda das constraints)

### Implementation

- [x] T059 [US3] Hash canônico SHA-256 em `src/application/idempotency/payload-hash.ts`
- [x] T060 [US3] Verificação de replay/conflito, gravação de `result_balance`/`result_wallet_version` e releitura após `23505` em `src/application/use-cases/submit-wager-transaction.ts`
- [x] T061 [US3] Header `Idempotency-Key` obrigatório (400 `MISSING_IDEMPOTENCY_KEY`) e `idempotentReplay` na resposta em `src/interfaces/http/`
- [x] T062 [US3] Métrica `idempotency_duplicates_total{channel}`

**Checkpoint**: MVP (US1 + US2 + US3) completo: wallet, aposta e idempotência corretas.

---

## Phase 6: User Story 4 — Liquidar rodada com ganho ou perda (P2)

**Goal**: WIN credita; LOSS registra sem mover saldo; referências de WIN/LOSS validadas.

**Independent Test**: BET + WIN credita; BET + LOSS não muda saldo nem extrato.

### Tests

- [x] T063 [P] [US4] Testes de regras de WIN/LOSS em `tests/unit/application/win-loss-rules.test.ts` (WIN sem BET aceito, referência de outra rodada rejeitada, `REFERENCE_REVERSED`)
- [x] T064 [P] [US4] Integração em `tests/integration/win-loss.test.ts` (crédito com `version + 1`, LOSS sem ledger, **sem mudar `version`** e com evento, LOSS de `0.00` aceito, free spin, WIN referenciando BET ausente → 202 e, após o prazo, `REFERENCE_NOT_FOUND`, `assertReconciled`)

### Implementation

- [x] T065 [US4] Resolução e validação de referência compartilhada (`ReferenceResolver`) em `src/application/use-cases/reference-resolver.ts`
- [x] T066 [US4] Regras de WIN e LOSS em `src/application/use-cases/submit-wager-transaction.ts`

---

## Phase 7: User Story 5 — Reverter operações, inclusive fora de ordem (P2)

**Goal**: REFUND/ROLLBACK corretos, uma reversão por transação, pendentes com prazo.

**Independent Test**: ROLLBACK antes da BET → 202 → BET chega → ROLLBACK aplicado → saldo final =
inicial.

### Tests

- [x] T067 [P] [US5] Testes de regras de reversão em `tests/unit/application/reversal-rules.test.ts` (tipos aceitos, valor igual, direção do ROLLBACK, `REVERSAL_INSUFFICIENT_FUNDS` ≠ `INSUFFICIENT_FUNDS`, `REFERENCE_ALREADY_REVERSED`)
- [x] T068 [P] [US5] Integração em `tests/integration/reversals.test.ts` (REFUND, ROLLBACK de BET/WIN/REFUND, segunda reversão rejeitada, cadeia BET → REFUND → ROLLBACK → REFUND rejeitado com saldo 75)
- [x] T069 [P] [US5] Integração em `tests/integration/pending-reference.test.ts` com TTL e backoff em segundos: referência chega e é aplicada; referência chega rejeitada → `REFERENCE_NOT_PROCESSED`; prazo esgota → `REFERENCE_NOT_FOUND` + linha `WagerTransactionRejected` na outbox (a publicação é verificada no US7); replay de uma operação pendente devolve o estado atual, inclusive depois de resolvida (FR-026a)
- [x] T070 [P] [US5] Concorrência em `tests/concurrency/concurrent-reversals.test.ts`: REFUND e ROLLBACK da mesma BET em paralelo, em instâncias diferentes → só um aplicado
- [x] T071 [P] [US5] Concorrência em `tests/concurrency/out-of-order.test.ts`: ROLLBACK/REFUND entregue antes da referência com 3 instâncias e o worker rodando em todas

### Implementation

- [x] T072 [US5] Regras de REFUND e ROLLBACK (incluindo `ledgerDirectionFor`) em `src/domain/wagering/wager-transaction.ts` e `src/application/use-cases/submit-wager-transaction.ts`
- [x] T073 [US5] Registro em `PENDING_REFERENCE` com `attempts`, `next_attempt_at`, `expires_at` e evento `WagerTransactionPendingReference`
- [x] T074 [US5] Caso de uso `ReprocessPendingReference` em `src/application/use-cases/reprocess-pending-reference.ts`
- [x] T075 [US5] `PendingReferenceWorker` (`FOR UPDATE SKIP LOCKED`, lote 20, ciclo de 1 s, backoff configurável) em `src/infrastructure/workers/pending-reference.worker.ts`
- [x] T076 [US5] Métrica `retries_total{component="pending_reference"}`

---

## Phase 8: User Story 6 — Processar operações por fila, com recuperação de falhas (P2)

**Goal**: consumidor SQS com o mesmo caso de uso, inbox, ack após commit, classificação de erros,
DLQ e SIGTERM.

**Independent Test**: queda depois do commit e antes do ack → redelivery sem novo efeito.

### Tests

- [x] T077 [P] [US6] Testes de classificação de erros em `tests/unit/infrastructure/error-classification.test.ts`
- [x] T078 [P] [US6] Integração em `tests/integration/sqs-consumer.test.ts`: mesmo resultado que o HTTP, inbox deduplicando redelivery, rejeição com ack, `OPENING` rejeitado, e a **mesma operação enviada ao mesmo tempo por HTTP e pela fila** → um único efeito (o outro canal recebe replay)
- [x] T079 [P] [US6] Integração em `tests/integration/sqs-retry-dlq.test.ts`: Postgres parado → retry com backoff, sem efeito parcial; mensagem ilegível → DLQ após 5 recebimentos; erro permanente com banco acessível → `FAILED` + ack
- [x] T080 [P] [US6] Concorrência em `tests/concurrency/crash-after-commit-before-ack.test.ts` com `FAULT_INJECTION=crash_after_commit_before_ack`
- [x] T081 [P] [US6] Integração em `tests/integration/graceful-shutdown.test.ts`: `SIGTERM` com mensagens em andamento → concluídas ou devolvidas, sem perda

### Implementation

- [x] T082 [US6] Cliente SQS e schema zod da mensagem `WagerTransactionRequested` em `src/infrastructure/messaging/sqs/`
- [x] T083 [US6] `InboxRepository` e inserção `ON CONFLICT DO NOTHING` na transação do caso de uso
- [x] T084 [US6] `WagerTransactionsConsumer` (long polling, classificação R9, `ChangeMessageVisibility` com backoff, ack após commit) em `src/infrastructure/messaging/sqs/wager-transactions.consumer.ts`
- [x] T085 [US6] Gravação de `FAILED` + `WagerTransactionFailed` para erro permanente com banco acessível
- [x] T086 [US6] Desligamento gracioso (`enableShutdownHooks`, espera de até 20 s, devolução de visibilidade) em `src/main.ts` e no consumidor
- [x] T087 [US6] Métricas de retries e gauge `dlq_messages`

---

## Phase 9: User Story 7 — Notificar sistemas consumidores sem perda (P2)

**Goal**: publisher da outbox at-least-once com vários publishers.

**Independent Test**: queda depois do commit e antes de publicar → outra instância publica.

### Tests

- [x] T088 [P] [US7] Integração em `tests/integration/outbox-publisher.test.ts`: evento só depois do commit, nenhum evento para transação desfeita, retry com backoff quando o SQS cai, `WalletBalanceChanged` só quando o saldo muda
- [x] T089 [P] [US7] Concorrência em `tests/concurrency/concurrent-publishers.test.ts`: dois publishers na mesma outbox → nenhum evento perdido; duplicatas com o mesmo `eventId`
- [x] T090 [P] [US7] Concorrência em `tests/concurrency/crash-before-publish.test.ts` com `FAULT_INJECTION=crash_after_commit_before_publish`

### Implementation

- [x] T091 [US7] `SqsEventPublisher` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`) em `src/infrastructure/messaging/sqs/sqs-event-publisher.ts`
- [x] T092 [US7] `OutboxPublisherWorker` (`FOR UPDATE SKIP LOCKED`, lote 10, ciclo de 500 ms, `scheduleRetry`) em `src/infrastructure/workers/outbox-publisher.worker.ts`
- [x] T093 [US7] Gauge `outbox_lag_seconds`

---

## Phase 10: User Story 8 — Consultar, auditar e reconciliar (P3)

**Goal**: consultas, extrato paginado estável e reconciliação sem correção automática.

**Independent Test**: após várias operações, reconciliação com diferença zero; divergência
injetada é sinalizada.

### Tests

- [x] T094 [P] [US8] Integração em `tests/integration/queries.test.ts`: wallet, transação por id e por `(providerId, externalTransactionId)`, 404
- [x] T095 [P] [US8] Integração em `tests/integration/ledger-pagination.test.ts`: cursor opaco, sem repetição nem lacuna com lançamentos novos durante a paginação
- [x] T096 [P] [US8] Integração em `tests/integration/reconciliation.test.ts`: consistente; divergência injetada (desligando o trigger só no teste) → `consistent: false`, log e métrica, nada corrigido

### Implementation

- [x] T097 [P] [US8] Queries `GetWallet`, `GetLedgerPage`, `GetTransaction` em `src/application/queries/`
- [x] T098 [US8] Caso de uso `ReconcileWallet` (`REPEATABLE READ`) em `src/application/use-cases/reconcile-wallet.ts`
- [x] T099 [US8] Controllers de consulta, extrato, providers e reconciliação em `src/interfaces/http/controllers/`

---

## Phase 11: User Story 9 — Operar e diagnosticar o serviço (P3)

**Goal**: liveness, readiness e métricas expostas sem autenticação.

**Independent Test**: Postgres parado → `live` 200, `ready` 503.

### Tests

- [x] T100 [P] [US9] Integração em `tests/integration/health.test.ts` (live, ready com Postgres e SQS, ready 503 com Postgres parado, `/metrics` com as métricas mínimas) e, com o Postgres parado, `POST /wagering/transactions` → 503 com `Retry-After`; ao religar, o reenvio com a mesma chave é processado do zero (FR-040b)
- [x] T101 [P] [US9] Teste em `tests/integration/logging.test.ts`: logs JSON com os campos de correlação e sem `amount`/payload completo

### Implementation

- [x] T102 [US9] `HealthController` (`/health/live`, `/health/ready`) e `MetricsController` (`/metrics`) em `src/interfaces/http/controllers/`

---

## Phase 12: Polish & Cross-Cutting

- [x] T103 [P] Teste de recuperação após reinício (`tests/concurrency/restart-consistency.test.ts`): carga mista, reinício de instâncias, reconciliação de todas as wallets com diferença zero (SC-004)
- [x] T104 [P] `README.md` com setup, comandos e como rodar com 3 instâncias
- [x] T105 `ARCHITECTURE.md` com as decisões de [research.md](./research.md), as decisões de negócio da spec, trade-offs, limitações conhecidas (BET atrasada, ordem de eventos, head-of-line blocking) e o desenho de autenticação com Keycloak (Q1)
- [x] T106 Revisão contra as falhas eliminatórias da constituição (checklist em `ARCHITECTURE.md`)
- [x] T107 Rodar todos os cenários de [quickstart.md](./quickstart.md) e registrar o resultado
- [x] T108 [P] *(Opcional)* Teste de carga `bun run test:load` em `tests/load/` com throughput, p50/p95/p99, taxa de erro, conflitos de lock e outbox lag
- [ ] T109 *(Opcional)* Adaptador `JwtProviderIdentity` com Keycloak (somente se o núcleo estiver completo)

---

## Dependencies & Execution Order

### Phases

- **Setup (1)** → **Foundational (2)** → histórias → **Polish (12)**.
- T008 (spike) precisa passar antes do resto da Fase 2.

### User Stories

```text
US1 (wallet) ──► US2 (BET) ──► US3 (idempotência) ══ MVP
                                   │
                 ┌─────────────────┼──────────────────┬──────────────┐
                 ▼                 ▼                  ▼              ▼
             US4 (WIN/LOSS)    US6 (SQS)          US7 (outbox)   US8 (consultas)
                 │
                 ▼
             US5 (reversões + pendentes)                          US9 (ops) — independente após Fase 2
```

- US2 precisa da wallet de US1; US3 estende o caso de uso de US2.
- US4, US6, US7 e US8 dependem só do MVP e podem ser feitas em qualquer ordem.
- US5 reutiliza o `ReferenceResolver` de US4.
- US6 e US7 juntas cobrem os cenários de queda. Os testes de US1–US6 verificam eventos pela
  linha gravada na outbox; a publicação no SQS só é verificada a partir do US7.

### Within Each Story

Testes primeiro (devem falhar) → domínio → repositórios → caso de uso → borda (HTTP/SQS) →
métricas.

### Parallel Opportunities

- Fase 1: T003–T007 em paralelo.
- Fase 2: domínio (T009–T019) em paralelo com portas e schemas (T026–T027); T032–T036 em paralelo.
- Em cada história, todos os testes `[P]` podem ser escritos ao mesmo tempo.
- Depois do MVP: US4, US6, US7, US8 e US9 em paralelo, se houver mais de uma pessoa.

### Parallel Example: User Story 2

```text
T044 tests/unit/domain/wager-transaction.test.ts
T045 tests/unit/application/bet-rules.test.ts
T046 tests/integration/bet.test.ts
T047 tests/concurrency/hot-wallet.test.ts
T048 tests/concurrency/parallel-wallets.test.ts
T049 tests/concurrency/multi-instance.test.ts
```

## Implementation Strategy

### MVP First (prazo curto)

1. Fase 1 + Fase 2.
2. US1 → US2 → US3. **Parar e validar**: cenários 1–6 do quickstart e o teste de 3 instâncias.
   Isso já cobre as áreas de maior peso (correção financeira, concorrência, idempotência = 55 pts)
   e afasta as falhas eliminatórias de duplicidade e race.
3. US7 (outbox) e US6 (SQS): mensageria e falhas (15 pts) e as eliminatórias de evento antes do
   commit.
4. US4 e US5: completam as regras de negócio.
5. US8 e US9: reconciliação, consultas e health.
6. Polish: `ARCHITECTURE.md` e `README.md` (documentação = 5 pts, e base da entrevista).

### Corte de escopo, se o prazo apertar

Nunca cortar: testes de concorrência, invariantes no schema, outbox e inbox. Pode ficar para depois:
teste de carga (T108), JWT (T109), extrato paginado sofisticado.
