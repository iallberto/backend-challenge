# Contract: Failure Codes

Taxonomia estável e legível por máquina (FR-041). Os códigos nunca são renomeados; códigos novos
só são adicionados. O campo `retryable` diz ao provedor se reenviar **a mesma operação, com a
mesma chave** pode dar outro resultado.

| Código | Categoria | HTTP | Persistido | `retryable` | Significado / ação do provedor |
|---|---|---|---|---|---|
| `INVALID_PAYLOAD` | validação | 400 | não | não | Campo ausente ou com formato inválido. Corrigir e reenviar. |
| `INVALID_MONEY` | validação | 400 | não | não | Valor fora do formato decimal de 2 casas, negativo, NaN, acima de 17 dígitos inteiros, ou zero em BET/WIN/REFUND/ROLLBACK. |
| `MISSING_IDEMPOTENCY_KEY` | validação | 400 | não | não | Header `Idempotency-Key` ausente. |
| `MISSING_REFERENCE` | validação | 400 | não | não | REFUND/ROLLBACK sem `referenceExternalTransactionId`. |
| `OPENING_NOT_ALLOWED` | validação | 400 | não | não | `OPENING` é interno. |
| `PROVIDER_MISMATCH` | autorização | 403 | não | não | `providerId` do corpo ≠ identidade do chamador. |
| `IDEMPOTENCY_KEY_CONFLICT` | conflito | 409 | — | não | Mesma chave com conteúdo de negócio diferente. |
| `EXTERNAL_ID_CONFLICT` | conflito | 409 | — | não | Mesmo `providerId` + `externalTransactionId` com outra chave. |
| `WALLET_ALREADY_EXISTS` | conflito | 409 | — | não | Já existe wallet para o jogador nessa moeda. |
| `WALLET_NOT_FOUND` | negócio | 422 | sim | não | Wallet informada não existe. |
| `WALLET_PLAYER_MISMATCH` | negócio | 422 | sim | não | Wallet não pertence ao `playerId`. |
| `CURRENCY_MISMATCH` | negócio | 422 | sim | não | Moeda da operação ≠ moeda da wallet. |
| `INSUFFICIENT_FUNDS` | negócio | 422 | sim | não | BET maior que o saldo. |
| `REVERSAL_INSUFFICIENT_FUNDS` | negócio | 422 | sim | não | ROLLBACK de crédito deixaria saldo negativo. Situação operacional distinta: exige análise. |
| `REFERENCE_NOT_FOUND` | negócio | 422 | sim | não | Referência não chegou dentro do prazo (1 h). |
| `REFERENCE_NOT_PROCESSED` | negócio | 422 | sim | não | Referência existe, mas foi rejeitada ou falhou. |
| `REFERENCE_MISMATCH` | negócio | 422 | sim | não | Referência de outro provider, player, wallet, moeda ou rodada. |
| `INVALID_REFERENCE_KIND` | negócio | 422 | sim | não | Ex.: REFUND referenciando WIN; ROLLBACK referenciando ROLLBACK. |
| `REFERENCE_ALREADY_REVERSED` | negócio | 422 | sim | não | A referência já recebeu uma reversão (REFUND ou ROLLBACK). |
| `REFERENCE_REVERSED` | negócio | 422 | sim | não | WIN/LOSS referenciando BET já revertida. |
| `REVERSAL_AMOUNT_MISMATCH` | negócio | 422 | sim | não | Valor da reversão ≠ valor da referência. |
| `SERVICE_UNAVAILABLE` | transitório | 503 | não | **sim** | Banco/fila indisponível ou lock timeout. Reenviar com a mesma chave após `Retry-After`. |
| `INTERNAL_ERROR` | permanente | 500 | sim, como `FAILED` (se possível) | não | Erro inesperado não-negocial. Acionar suporte. |

Regras:

- O replay de uma operação persistida devolve o mesmo código e o mesmo HTTP (FR-040a).
- Conflitos (409) não criam nem alteram nada; a operação original continua como estava.
- Códigos de `422` acompanham `transactionId` e `status: "REJECTED"`; os de `400`, `403` e `503`
  não têm `transactionId`, porque nada foi gravado.
