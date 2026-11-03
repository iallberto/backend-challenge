# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) de múltiplos provedores de jogos, por **HTTP** e por **SQS**, e permanece correto com
mensagens duplicadas, entregues fora de ordem, processadas simultaneamente por várias instâncias e
interrompidas por quedas.

- Enunciado original: [docs/CHALLENGE.md](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)
- Especificação, plano e contratos (Spec Kit): [specs/001-distributed-wagering-processor/](specs/001-distributed-wagering-processor/)

## Stack

Bun 1.x · TypeScript estrito · NestJS 11 · PostgreSQL 16 · MikroORM 6 · AWS SQS (LocalStack 3.8) ·
Docker Compose · zod · pino · prom-client

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose
- Portas livres: `55432` (Postgres), `4566` (LocalStack), `3100–3109` (aplicação)

## Setup

```bash
bun install
```

```bash
docker compose up -d postgres localstack
```

```bash
bun run migration:up
```

```bash
bun run start
```

A aplicação sobe em `http://localhost:3100` (configurável por variáveis: ver [.env.example](.env.example)).
O LocalStack cria as filas no boot (`docker/localstack/init-sqs.sh`):
`wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount = 5`) e
`wagering-events.fifo` (eventos publicados pela outbox).

### Três instâncias em Docker

```bash
docker compose --profile app up -d --build --scale app=3
```

As réplicas ficam em portas da faixa `3100–3102`, aplicam as migrations no boot e compartilham o
mesmo Postgres e as mesmas filas. Cada instância roda a API, o consumidor SQS, o publisher da
outbox e o worker de referências pendentes.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe uma instância |
| `bun run migration:up` / `migration:down` | Aplica / reverte as migrations |
| `bun run typecheck` | Verificação de tipos (`tsc --noEmit`) |
| `bun test` | Todos os testes (precisa de Postgres e LocalStack rodando) |
| `bun run test:unit` | Só os testes de domínio (sem infraestrutura) |
| `bun run test:integration` | Integração com Postgres e LocalStack reais |
| `bun run test:concurrency` | Paralelismo real, 3 processos, quedas injetadas |
| `bun run test:load` | Teste de carga contra uma instância rodando (`BASE_URL`) |

## Exemplo rápido

```bash
curl -s -X POST localhost:3100/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
curl -s -X POST localhost:3100/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -H 'X-Provider-Id: provider-a' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

`X-Provider-Id` é o adaptador de identidade **de desenvolvimento** (ver "Autenticação" em
[ARCHITECTURE.md](ARCHITECTURE.md#9-autenticação-e-autorização)).

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet; saldo inicial > 0 gera `OPENING` + crédito no ledger |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Extrato com cursor opaco e estável |
| `POST /wallets/:walletId/reconciliation` | Saldo guardado × saldo reconstruído pelo ledger |
| `POST /wagering/transactions` | Submete operação (`Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Transação por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness e readiness (Postgres + SQS), sem autenticação |
| `GET /metrics` | Métricas Prometheus |

Códigos HTTP por situação: `201` processada · `202` aguardando referência · `400` payload inválido ·
`403` provider ≠ chamador · `409` conflito de idempotência · `422` rejeição de negócio ·
`500` falha permanente (`FAILED`) · `503` falha transitória (com `Retry-After`).
Um replay devolve o **mesmo** código do resultado original, com `idempotentReplay: true`.
Taxonomia completa: [contracts/failure-codes.md](specs/001-distributed-wagering-processor/contracts/failure-codes.md).

## Testes

Todos os testes de integração e de concorrência usam **PostgreSQL e LocalStack reais** e sobem
**processos reais** da aplicação (`Bun.spawn`). Nenhum teste substitui o banco ou a fila por mock.
Resultado na máquina de desenvolvimento: **137 testes, 0 falhas** (62 de unidade, 54 de integração,
21 de concorrência), rodando a suíte completa duas vezes seguidas.

| Exigência (README §13) | Onde |
|---|---|
| `Money`: escala, arredondamento, entradas inválidas | `tests/unit/domain/money.test.ts` |
| Invariantes da `Wallet`; regras de BET/WIN/LOSS/REFUND/ROLLBACK; conflito de moeda | `tests/unit/domain/wallet.test.ts`, `wagering-policy.test.ts` |
| Idempotency key com payload divergente | `tests/integration/api-wallet-and-bet.test.ts` |
| Migrations e constraints | `tests/integration/schema-constraints.test.ts` |
| Atomicidade wallet/ledger/inbox/outbox | `api-wallet-and-bet.test.ts`, `sqs-consumer.test.ts` |
| Inbox e redelivery; retry e DLQ | `tests/integration/sqs-consumer.test.ts` |
| Publishers concorrentes sobre a mesma outbox | `tests/concurrency/crash-recovery.test.ts` |
| Recuperação após reinicialização | `crash-recovery.test.ts`, `zz-health-and-outage.test.ts` |
| 1. Mesma aposta 50× em paralelo | `tests/concurrency/races.test.ts` |
| 2. Disputa de saldo (100 / 80 / 80) | `races.test.ts` (10 rodadas, alternando instâncias) |
| 3. Wallets distintas em paralelo | `races.test.ts` |
| 4. ≥ 3 instâncias simultâneas | `races.test.ts` (todo o arquivo roda com 3 processos) |
| 5. Worker morto depois do commit e antes do ack | `crash-recovery.test.ts` |
| 6. Dois publishers sobre a mesma outbox | `crash-recovery.test.ts` |
| 7. ROLLBACK/REFUND antes da referência | `pending-reference.test.ts`, `races.test.ts` |
| 8. Reinício com consistência final | `crash-recovery.test.ts` (kill -9 no meio da carga) |

Todo teste que movimenta saldo termina com `assertReconciled`: `wallet.balance == saldo do ledger`.

> No Windows não existe SIGTERM real; o teste de desligamento gracioso verifica "nada perdido nem
> duplicado" em qualquer SO e o código de saída 0 só em Linux. Em container Linux a saída 0 foi
> verificada (`docker stop` → `exit=0`).

## Teste de carga

```bash
BASE_URL=http://localhost:3100 DURATION_S=15 CONCURRENCY=32 WALLETS=50 bun run test:load
```

Resultados e análise em [ARCHITECTURE.md §12](ARCHITECTURE.md#12-teste-de-carga).

## Estrutura

```text
src/
├── domain/           regras puras (Money, Wallet, WagerTransaction, ledger, eventos, outbox/inbox)
├── application/      casos de uso, portas, validação, idempotência
├── infrastructure/   MikroORM/Postgres, SQS, workers, observabilidade, injeção de falha
├── interfaces/http/  controllers NestJS, mapeamento de erros
├── container.ts      composition root
└── main.ts           boot e desligamento gracioso
tests/                unit · integration · concurrency · load · support
specs/                spec, plano, pesquisa, modelo de dados, contratos, tarefas (Spec Kit)
```
