# Quickstart: validação ponta a ponta

Guia para provar que a feature funciona. Contratos em [contracts/](./contracts/); schema em
[data-model.md](./data-model.md).

## Pré-requisitos

- Bun 1.x
- Docker + Docker Compose
- Portas livres: 5432 (Postgres), 4566 (LocalStack), 3000–3002 (app)

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

Para três instâncias: `docker compose up --scale app=3`.

## Comandos de teste

| Comando | O que roda |
|---|---|
| `bun run test:unit` | domínio puro, sem infraestrutura |
| `bun run test:integration` | Postgres e LocalStack reais |
| `bun run test:concurrency` | paralelismo real, 3+ processos, ganchos de falha |
| `bun test` | todos |
| `bun run test:load` | opcional, teste de carga |

## Cenários de validação (e resultado esperado)

| # | Cenário | Resultado esperado | Spec |
|---|---|---|---|
| 1 | Abrir wallet com `1000.00 BRL` | 201, versão 1, um crédito `OPENING` no extrato | US1 |
| 2 | Abrir de novo para o mesmo jogador + moeda | 409 `WALLET_ALREADY_EXISTS` | US1 |
| 3 | Saldo `100.00`, duas BETs de `80.00` em paralelo | uma 201, uma 422 `INSUFFICIENT_FUNDS`, saldo `20.00`, um débito | US2, SC-002 |
| 4 | Mesma BET 50× em paralelo | um débito; 49 replays com o mesmo resultado | US3, SC-001 |
| 5 | Mesma chave, valor diferente | 409 `IDEMPOTENCY_KEY_CONFLICT` | US3 |
| 6 | Mesmo id externo, chave diferente | 409 `EXTERNAL_ID_CONFLICT`, sem segundo débito | FR-028a |
| 7 | REFUND e depois ROLLBACK da mesma BET | o segundo: 422 `REFERENCE_ALREADY_REVERSED` | FR-049 |
| 8 | ROLLBACK antes da BET, BET em seguida | 202, depois o ROLLBACK é aplicado; saldo final = inicial | US5, SC-007 |
| 9 | REFUND pendente, BET chega rejeitada | REFUND 422 `REFERENCE_NOT_PROCESSED` | FR-023a |
| 10 | Mensagem SQS + queda após commit e antes do ack | redelivery sem novo efeito | US6, SC-006 |
| 11 | Queda após commit e antes de publicar a outbox | outra instância publica o evento | US7, SC-005 |
| 12 | Dois publishers sobre a mesma outbox | nenhum evento perdido; duplicatas com o mesmo `eventId` | US7 |
| 13 | Mensagem ilegível na fila | DLQ após 5 recebimentos | FR-032a |
| 14 | Postgres parado | `/health/live` 200, `/health/ready` 503, `POST` 503 | US9 |
| 15 | Reiniciar o serviço no meio de uma carga | reconciliação de todas as wallets com diferença zero | SC-004 |

## Verificação manual rápida

1. `POST /wallets` com saldo `100.00`.
2. `POST /wagering/transactions` com BET de `25.00` → 201, saldo `75.00`.
3. Repetir a mesma requisição → mesma resposta, `idempotentReplay: true`.
4. `POST /wallets/{id}/reconciliation` → `consistent: true`, `checkedEntries: 2`.
5. Ler a fila `wagering-events.fifo` no LocalStack → `WagerTransactionProcessed` e
   `WalletBalanceChanged`.
