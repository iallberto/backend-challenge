# Implementation Plan: Distributed Wagering Processor

**Branch**: `spec/wagering-processor` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-distributed-wagering-processor/spec.md`

## Summary

Serviço financeiro que recebe operações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) por HTTP e
por SQS, aplica-as a wallets com saldo materializado e ledger imutável, e publica eventos de
integração. A correção sob duplicidade, fora de ordem, concorrência e quedas vem de cinco
mecanismos, todos apoiados no PostgreSQL:

1. **Lock pessimista por wallet** (`SELECT … FOR UPDATE`) contra lost update (R4).
2. **Idempotência persistente**: lock + verificação + constraints únicas em `idempotency_key` e
   em `(provider_id, external_transaction_id)` (R5).
3. **Inbox** na mesma transação, contra redelivery do SQS (R7).
4. **Transactional outbox** com publishers `SKIP LOCKED`, contra dual write (R8).
5. **Invariantes no schema**: `CHECK`, índices únicos (inclusive o parcial de reversão única) e
   triggers de imutabilidade (R11).

O domínio (Money, Wallet, WagerTransaction, ledger) é TypeScript puro, sem NestJS nem ORM; a
infraestrutura entra por portas e adaptadores.

## Technical Context

**Language/Version**: TypeScript 5.x (modo estrito) sobre Bun 1.x

**Primary Dependencies**: NestJS 11, MikroORM 6 (`@mikro-orm/postgresql`, `@mikro-orm/migrations`),
`@aws-sdk/client-sqs` v3, zod, pino, prom-client

**Storage**: PostgreSQL 16

**Testing**: `bun test`; integração com Postgres e LocalStack reais via Docker Compose;
concorrência com múltiplos processos (`Bun.spawn`) e ganchos de injeção de falha

**Target Platform**: container Linux (Docker Compose local)

**Project Type**: web service (API HTTP + consumidor SQS + workers em background, no mesmo processo)

**Performance Goals**: sem meta de RPS no desafio. Objetivo qualitativo: wallets distintas em
paralelo sem espera mútua (SC-009); latência de processamento medida em histograma

**Constraints**: correção com 3+ instâncias; nenhum `number` para dinheiro; nenhum evento antes do
commit; `lock_timeout` de 5 s; ack só após commit; desligamento gracioso em até 20 s

**Scale/Scope**: 5 tabelas, 1 agregado principal, 2 canais de entrada, 3 workers (consumidor
SQS, publisher da outbox, reprocessador de pendentes)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Como o plano atende | Status |
|---|---|---|
| I. Correção financeira | `Money` com `bigint` e string de 2 casas (R3); ledger criado pelo agregado; reconciliação (data-model §3) | ✅ |
| II. Invariantes no banco | `CHECK`, `UNIQUE`, índice parcial de reversão, triggers de imutabilidade; migrations com `up` e `down` (R11) | ✅ |
| III. Idempotência persistente | chave + hash canônico + dupla unicidade no banco; replay com saldo gravado (R5, R6) | ✅ |
| IV. Concorrência por wallet | lock de linha por wallet, sem lock global; testes com 3 processos (R4, R16) | ✅ |
| V. Atomicidade e mensageria | inbox + efeito + outbox na mesma transação; ack após commit; classificação de erros; SIGTERM (R7–R9) | ✅ |
| VI. Domínio encapsulado | factories `create`/`open`/`rehydrate`; modelos de persistência separados; mesmo caso de uso para HTTP e SQS (R2) | ✅ |
| VII. Testes com infra real | Postgres e LocalStack reais; paralelismo real; invariante saldo = ledger em todo teste (R16) | ✅ |
| VIII. Observabilidade e simplicidade | logs JSON com correlação, métricas mínimas, health separados (R14); decisões em `ARCHITECTURE.md` | ✅ |

**Re-check pós-design (Fase 1)**: ✅ todos os princípios mantidos. Ajuste feito durante o design:
`PROVIDER_MISMATCH` passou a ser 403 **sem persistência**, para que um provedor não consiga
bloquear chaves de idempotência de outro (data-model §1.3, passo 3).

## Project Structure

### Documentation (this feature)

```text
specs/001-distributed-wagering-processor/
├── spec.md
├── plan.md              # este arquivo
├── research.md          # decisões técnicas (Fase 0)
├── data-model.md        # domínio e schema (Fase 1)
├── quickstart.md        # cenários de validação (Fase 1)
├── contracts/
│   ├── http-api.md
│   ├── messaging.md
│   └── failure-codes.md
├── checklists/
│   └── requirements.md
└── tasks.md             # gerado por /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/                      # TypeScript puro: sem NestJS, sem ORM
│   ├── money/                   # Money, erros monetários
│   ├── wallet/                  # Wallet (aggregate root), WalletLedgerEntry
│   ├── wagering/                # WagerTransaction, kinds, status, FailureCode
│   ├── messaging/               # InboxMessage, OutboxMessage
│   ├── events/                  # IntegrationEvent + uma subclasse por evento
│   └── shared/                  # DomainError, Clock, tipos base
├── application/
│   ├── ports/                   # repositórios, UnitOfWork, ProviderIdentityPort,
│   │                            # EventPublisher, IdGenerator, Clock
│   ├── use-cases/               # OpenWallet, SubmitWagerTransaction,
│   │                            # ReprocessPendingReference, ReconcileWallet
│   ├── queries/                 # GetWallet, GetLedgerPage, GetTransaction
│   └── idempotency/             # hash canônico
├── infrastructure/
│   ├── persistence/
│   │   ├── schemas/             # EntitySchema dos *Record
│   │   ├── mappers/             # Record ↔ domínio (rehydrate)
│   │   ├── repositories/
│   │   ├── migrations/
│   │   └── mikro-orm.config.ts
│   ├── messaging/sqs/           # cliente, consumidor, publisher
│   ├── workers/                 # OutboxPublisherWorker, PendingReferenceWorker
│   ├── identity/                # DevHeaderProviderIdentity
│   ├── observability/           # logger, métricas, contexto de correlação
│   └── fault-injection/         # ganchos ativados só em teste
├── interfaces/http/
│   ├── controllers/             # wallets, wagering, providers, reconciliation, health, metrics
│   ├── dto/                     # schemas zod
│   └── error-mapping.ts         # resultado/erro → HTTP (contracts/failure-codes.md)
├── app.module.ts
└── main.ts

tests/
├── unit/                        # domínio
├── integration/                 # migrations, constraints, atomicidade, inbox, outbox, DLQ
├── concurrency/                 # 50× paralelo, hot wallet, 3 processos, quedas
├── support/                     # spawn de instâncias, cliente HTTP, helpers de reconciliação
└── load/                        # opcional

docker/
└── localstack/init-sqs.sh       # cria filas e redrive
docker-compose.yml
ARCHITECTURE.md
README.md
```

**Structure Decision**: projeto único (web service) em camadas hexagonais: `domain` não importa
nada de fora; `application` depende só de `domain` e das próprias portas; `infrastructure` e
`interfaces` implementam as portas e dependem das camadas internas, nunca o contrário.

## Complexity Tracking

| Complexidade | Por que é necessária | Alternativa mais simples rejeitada porque |
|---|---|---|
| Modelos de persistência separados + mappers | Domínio sem ORM e reidratação explícita por `rehydrate` (Constituição VI) | Mapear o domínio direto no ORM: tipos do ORM vazariam e o construtor privado seria contornado |
| Ganchos de injeção de falha | Tornar determinísticos os testes de queda entre commit e ack/publicação (Constituição VII) | Matar o processo por tempo: não é reproduzível |
| Três workers no mesmo processo | Consumidor, outbox e pendentes precisam rodar em todas as instâncias | Serviços separados: mais containers sem ganho para o desafio |

## Riscos e próximos passos

| Risco | Mitigação |
|---|---|
| Incompatibilidade Bun × NestJS × MikroORM | Spike como primeira tarefa |
| Head-of-line blocking no FIFO | Backoff curto no retry; o banco é a garantia, não a ordem |
| BET atrasada após expiração do ROLLBACK | Limitação documentada (spec, Assumptions) |
| Ordem de eventos com vários publishers | `walletVersion` no evento; documentado em `ARCHITECTURE.md` |

Próximo comando: `/speckit-tasks`.
