# Contract: Messaging (SQS)

## Filas

| Fila | Papel | Configuração |
|---|---|---|
| `wager-transactions.fifo` | entrada de operações dos provedores | visibility 30 s, redrive → DLQ com `maxReceiveCount = 5`; `MessageGroupId = walletId` |
| `wager-transactions-dlq.fifo` | mensagens que não puderam ser gravadas | retenção 14 dias; contada em `dlq_messages` |
| `wagering-events.fifo` | saída de eventos de integração (outbox) | `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId` |

## Mensagem de entrada: `WagerTransactionRequested`

```json
{ "messageId": "msg-123", "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "correlationId": "opcional",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "...", "walletId": "...", "roundId": "round-987", "gameId": "fortune-chimp",
    "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" },
    "referenceExternalTransactionId": null } }
```

- Deduplicação de transporte: `(consumer_name = "wager-transactions-consumer", messageId)`.
- Deduplicação de negócio: `data.idempotencyKey` (mesmas regras do HTTP).
- `type` diferente de `WagerTransactionRequested` → tratado como payload inválido (ack + log).
- Tratamento por resultado: ver [research.md R9](../research.md#r9-consumidor-sqs).

## Envelope de evento de saída

```json
{ "eventId": "...", "eventType": "WalletBalanceChanged", "version": 1,
  "aggregateId": "...", "correlationId": "...", "causationId": "...",
  "occurredAt": "2026-11-02T15:00:00.000Z", "data": { } }
```

Garantia de entrega: **at-least-once**. Consumidores devem deduplicar por `eventId` e, para
eventos de saldo, ordenar por `data.walletVersion`.

### `data` por evento (versão 1)

| Evento | `data` |
|---|---|
| `WagerTransactionProcessed` | `transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money, referenceTransactionId?, balance, processedAt` |
| `WagerTransactionRejected` | `transactionId, providerId, externalTransactionId, walletId, kind, money, failureCode` |
| `WagerTransactionFailed` | `transactionId, providerId, externalTransactionId, walletId, kind, failureCode` |
| `WagerTransactionPendingReference` | `transactionId, providerId, externalTransactionId, walletId, kind, referenceExternalTransactionId, expiresAt` |
| `WalletBalanceChanged` | `walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion` |

Valores monetários sempre como `MoneyProps` (string decimal), nunca como número.
