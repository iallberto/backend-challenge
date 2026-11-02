# Contract: HTTP API

Valores monetários sempre como `{ "amount": "25.00", "currency": "BRL" }`. Códigos de falha em
[failure-codes.md](./failure-codes.md).

Headers comuns:

| Header | Uso |
|---|---|
| `X-Correlation-Id` | opcional; gerado se ausente; devolvido na resposta |
| `X-Provider-Id` | identidade do chamador (adaptador de desenvolvimento, R15); obrigatório em `/wagering` |
| `Idempotency-Key` | obrigatório em `POST /wagering/transactions` |

Formato de erro (todas as rotas):

```json
{ "error": { "code": "INVALID_MONEY", "message": "texto para humanos", "details": [] } }
```

---

## POST /wallets

Request:

```json
{ "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" } }
```

| Resultado | HTTP | Corpo |
|---|---|---|
| Criada | 201 | `{ id, playerId, balance, version: 1 }` |
| Já existe (mesmo `playerId` + `currency`) | 409 | erro `WALLET_ALREADY_EXISTS` |
| Payload inválido | 400 | erro `INVALID_PAYLOAD` / `INVALID_MONEY` |

## GET /wallets/:walletId

200 `{ id, playerId, balance, version, createdAt, updatedAt }` · 404 se não existir.

## GET /wallets/:walletId/ledger?cursor=&limit=50

`limit` 1–200 (padrão 50). Ordem crescente de lançamento.

```json
{ "items": [ { "id": "...", "transactionId": "...", "direction": "DEBIT",
               "money": {...}, "balanceBefore": {...}, "balanceAfter": {...},
               "createdAt": "..." } ],
  "nextCursor": "b3BhcXVl" }
```

`nextCursor` é `null` na última página. Cursor inválido → 400 `INVALID_PAYLOAD`.

## GET /wagering/transactions/:transactionId
## GET /providers/:providerId/wagering/transactions/:externalTransactionId

200 com a representação da transação:

```json
{ "id": "...", "providerId": "provider-a", "externalTransactionId": "transaction-123",
  "walletId": "...", "playerId": "...", "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "BET", "money": {...}, "referenceExternalTransactionId": null,
  "status": "PROCESSED", "failureCode": null, "createdAt": "...", "processedAt": "..." }
```

404 se não existir.

## POST /wagering/transactions

Request (header `Idempotency-Key: provider-a:transaction-123`):

```json
{ "providerId": "provider-a", "externalTransactionId": "transaction-123",
  "playerId": "...", "walletId": "...", "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": null }
```

Resposta de resultado (sucesso, rejeição, pendência e replay):

```json
{ "transactionId": "...", "status": "PROCESSED", "failureCode": null,
  "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

| Situação | HTTP | `status` | Observação |
|---|---|---|---|
| Processada | 201 | `PROCESSED` | `balance` = saldo após a operação |
| Aguardando referência | 202 | `PENDING_REFERENCE` | resultado final chega por evento ou consulta |
| Rejeição de negócio | 422 | `REJECTED` | `failureCode` preenchido; `balance` = saldo observado |
| Falha permanente | 500 | `FAILED` | `failureCode: INTERNAL_ERROR` |
| Replay | igual ao original | igual ao original | `idempotentReplay: true` |
| Payload inválido | 400 | — | formato de erro |
| Provider ≠ chamador | 403 | — | `PROVIDER_MISMATCH` |
| Conflito | 409 | — | `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_ID_CONFLICT` |
| Falha transitória | 503 | — | header `Retry-After`; nada gravado |

O replay de um `PENDING_REFERENCE` devolve o estado **atual** da transação: se ela já foi
resolvida, devolve o resultado final (201/422) com `idempotentReplay: true`.

## POST /wallets/:walletId/reconciliation

200:

```json
{ "walletId": "...", "storedBalance": {...}, "calculatedBalance": {...},
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true, "checkedEntries": 42 }
```

404 se a wallet não existir. Divergência continua sendo `200` com `consistent: false`: a
reconciliação funcionou, e o resultado é a divergência.

## GET /health/live · GET /health/ready · GET /metrics

- `live`: 200 `{ "status": "ok" }` enquanto o processo responde.
- `ready`: 200 se Postgres e SQS respondem; 503 com `{ "status": "unavailable",
  "checks": { "postgres": "down", "sqs": "up" } }` caso contrário.
- `metrics`: formato de texto do Prometheus.

Nenhum dos três exige autenticação.
