# Arquitetura e decisões

Este documento explica **por que** o sistema é como é. O raciocínio completo, com alternativas
avaliadas, está em [specs/001-distributed-wagering-processor/research.md](specs/001-distributed-wagering-processor/research.md);
as decisões de negócio estão na [spec](specs/001-distributed-wagering-processor/spec.md) (seção
Clarifications e FR-048a, FR-049, FR-050).

## 1. Princípio central

Entrega *exactly-once* não existe em sistemas distribuídos: quem envia nunca sabe se a resposta se
perdeu e, por isso, reenvia. O sistema aceita entrega **at-least-once** e garante **efeito
exactly-once**: a mensagem pode chegar várias vezes, mas o dinheiro só se move uma vez.

Todas as garantias moram no **PostgreSQL**. As instâncias não conversam entre si; por isso o
sistema é correto com 1 ou com N instâncias.

## 2. Visão geral

```text
Provedor ──HTTP──┐                               ┌── Outbox publisher ──► wagering-events.fifo
                 ├─► SubmitWagerTransaction ──► PostgreSQL ──┤
Provedor ──SQS───┘    (mesmo caso de uso)                    └── Worker de pendentes
```

Cada instância roda quatro peças: API HTTP, consumidor SQS, publisher da outbox e worker de
referências pendentes. Camadas (hexagonal): `domain` (TypeScript puro) ← `application` (casos de
uso e portas) ← `infrastructure` / `interfaces` (adaptadores).

Jornada de uma operação, **em uma única transação SQL**:

1. Validação de formato e de valor (zod + `Money`); erro → `400`, nada gravado.
2. Autorização: `providerId` do corpo = identidade do chamador; senão `403`, nada gravado.
3. `SELECT … FROM wallet WHERE id = $1 FOR UPDATE` (lock da linha da wallet).
4. Inbox (só SQS): `(consumer_name, message_id)` já visto → duplicata, ack.
5. Idempotência: mesma chave + mesmo hash → replay; hash diferente → `409`; mesmo id externo com
   outra chave → `409`.
6. Regras (`applyWageringPolicy`, domínio puro).
7. Grava `wager_transaction` + `wallet_ledger_entry` + `wallet` + `outbox_message` (+ inbox).
8. `COMMIT`. O evento só sai depois, pelo publisher.

## 3. Dinheiro

- `Money` guarda **`bigint` de centavos** e a moeda; é imutável; operações entre moedas diferentes
  lançam erro de domínio.
- Contratos usam string decimal com 2 casas (`"25.00"`); entrada aceita `"25"`, `"25.5"`, `"25.50"`
  e rejeita `NaN`, `Infinity`, notação científica, sinal, vazio, mais de 2 casas e zeros à esquerda.
- Banco: `NUMERIC(19,2)` + `CHAR(3)`. A conversão `Money ↔ string` acontece só nos mappers.
- **Por que `bigint` e não `decimal.js`**: escala fixa de 2 casas e só soma/subtração; inteiros de
  centavos são exatos, nativos e sem dependência. Com divisão (juros, rateio), uma biblioteca
  decimal seria necessária.
- Valor zero só é aceito em `LOSS` e no saldo inicial (FR-002a). A regra é validada na borda **e**
  no `CHECK` do banco: toda constraint do banco tem uma validação equivalente na borda, para que
  um payload inválido vire `400`, e não um erro `500` vindo do banco.

## 4. ORM e estratégia transacional

- **MikroORM 6** (preferencial no desafio): Unit of Work, Identity Map, `em.transactional()` e
  `LockMode` explícitos.
- **Modelos de persistência separados do domínio**: `EntitySchema` em classes `*Record`
  (`src/infrastructure/persistence/schemas.ts`) e mappers que reconstroem o domínio por
  `rehydrate`. Assim o domínio não depende do ORM, e o construtor privado não é contornado.
  Custo aceito: um mapper por agregado.
- Isolamento `READ COMMITTED` + lock explícito. `REPEATABLE READ` só na reconciliação (foto
  consistente).
- `SET LOCAL lock_timeout = 5000ms` em toda transação: espera maior vira falha transitória (`503`
  ou retry da fila) e incrementa `wallet_lock_conflicts_total`.
- FKs `DEFERRABLE INITIALLY DEFERRED`: checadas no commit, independentes da ordem de flush do UoW.
- Migrations versionadas, com `up` e `down` (testadas num banco descartável).

## 5. Concorrência

**Lock pessimista por wallet** (`SELECT … FOR UPDATE`).

| Alternativa | Por que não |
|---|---|
| Otimista (`version` + retry) | Com hot wallet (50 requisições paralelas), só uma vence por rodada e as outras refazem tudo |
| `UPDATE … WHERE balance >= x` | Eficiente, mas dificulta gravar `balance_before/after` e aplicar regras de domínio antes |
| Lock global | Proibido: serializaria todas as wallets |

- O lock é da **linha**: wallets diferentes seguem em paralelo. O teste trava a wallet A por fora e
  mostra 50 operações em outras 10 wallets terminando enquanto A espera.
- Cada transação trava **uma** wallet; a ordem de locks é sempre wallet → transação (inclusive no
  reprocessamento de pendentes), então não há ciclo de deadlock.
- Defesa em camadas: `CHECK (balance >= 0)` na wallet e `CHECK (balance_after >= 0)` no ledger.
- `version` começa em 1 (a abertura faz parte da criação) e incrementa só quando o saldo muda.

## 6. Idempotência

- `Idempotency-Key` é a fonte da verdade; `payloadHash` = SHA-256 de um JSON canônico (chaves em
  ordem alfabética, sem espaços) com **apenas** campos de negócio: `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `amount`
  (normalizado para 2 casas), `currency` e `referenceExternalTransactionId`. Header, `messageId` e
  `occurredAt` ficam fora: a mesma operação por HTTP ou pela fila tem o mesmo hash.
- Duas constraints únicas: `idempotency_key` **e** `(provider_id, external_transaction_id)`. A
  segunda impede que um provedor que mude o formato da chave debite a mesma aposta duas vezes, e
  mantém sem ambiguidade a consulta por id externo e a resolução de referências.
- O replay devolve o resultado original **com o saldo daquele momento** (`result_balance`) e o
  **mesmo código HTTP**. Exceção: uma operação que estava pendente devolve o estado atual, porque
  ainda não tinha resultado final (FR-026a).
- Corrida entre a verificação e o commit (mesma chave com `walletId` diferente, locks diferentes):
  o `UNIQUE` barra a segunda; o caso de uso relê e devolve replay ou conflito.

## 7. Inbox, outbox e SQS

**Inbox** (`inbox_message`, PK `(consumer_name, message_id)`): deduplica o **transporte**; a
idempotency key deduplica o **negócio**. Ela é gravada na mesma transação do efeito.

**Transactional outbox**: o evento nasce na mesma transação do saldo, o que resolve o *dual write*
(banco + broker). O publisher roda em toda instância com `FOR UPDATE SKIP LOCKED` (lotes de 10):
publishers concorrentes pegam lotes diferentes. Se o processo morre no meio, a transação é desfeita
e outra instância publica. Se morre depois de publicar e antes de marcar `published_at`, o evento
sai de novo **com o mesmo `eventId`**: é o at-least-once previsto, e o consumidor deduplica por
`eventId`. O `MessageDeduplicationId = eventId` do FIFO absorve duplicatas dentro de 5 minutos,
como otimização.

**Consumidor SQS**:

| Resultado | Ação |
|---|---|
| Processada, rejeitada, pendente, replay, duplicata | ack (`DeleteMessage`) |
| Payload inválido mas legível | ack + log (reenviar não resolve) |
| Transitório (banco/fila fora, lock timeout) | sem ack; `ChangeMessageVisibility` com backoff |
| Permanente com banco acessível | grava `FAILED` + `WagerTransactionFailed`, ack |
| Ilegível ou sem registro possível | sem ack; após 5 recebimentos vai para a DLQ |

- **Ack só depois do commit.** Queda entre commit e ack: a mensagem reaparece depois do visibility
  timeout e a inbox a reconhece.
- **Erro transitório nunca vira `FAILED`**: senão o replay travaria a operação legítima para sempre.
- **SIGTERM**: para de buscar mensagens, conclui as que estão em andamento (até 20 s, menos que o
  visibility timeout de 30 s), devolve as não iniciadas (`ChangeMessageVisibility(0)`), para os
  workers e fecha conexões. Verificado em container Linux (`exit=0`).
- **SQS FIFO é otimização, não garantia**: deduplicação de 5 minutos, ordem só por
  `MessageGroupId` (= `walletId`) e a entrada HTTP nem passa pela fila. O banco é a garantia.
- Trade-off do FIFO por wallet: uma mensagem em retry bloqueia as seguintes da mesma wallet
  (*head-of-line blocking*). Aceito porque a ordem por wallet reduz `PENDING_REFERENCE`.

## 8. Regras de negócio e interpretações adotadas

| Decisão | Motivo |
|---|---|
| Cada transação é revertida **no máximo uma vez, por qualquer tipo** (índice único parcial `ux_reversal_once`) | A leitura literal ("não duas vezes pelo **mesmo** tipo") permitia REFUND + ROLLBACK da mesma BET: devolução em dobro. ROLLBACK de um REFUND continua permitido (é outra transação) |
| `WIN` sem referência é aceito (free spins, jackpots, entrega fora de ordem); `WIN`/`LOSS` com referência valida a referência; referência revertida → `REFERENCE_REVERSED` | A wallet é autoridade do dinheiro, não do resultado do jogo. Rejeitar prêmio legítimo é pior que aceitar um indevido, que o provedor pode reverter |
| Referência existente em estado terminal não processado → `REFERENCE_NOT_PROCESSED` imediato | Esperar algo que nunca vai mudar é desperdício e daria o código errado |
| Pendentes: backoff exponencial (1 s → teto 5 min, jitter ±20 %) e prazo de **1 h** | A rejeição por prazo é definitiva (o replay a repete); o prazo precisa cobrir timeouts e retries reais de provedores |
| Reversão que negativaria o saldo → `REVERSAL_INSUFFICIENT_FUNDS` (≠ `INSUFFICIENT_FUNDS`) | Situações operacionalmente diferentes (README §7.9) |
| `PROVIDER_MISMATCH` → `403`, **não gravado**, verificado antes da idempotência | Gravar a recusa permitiria a um provedor "envenenar" a chave de outro |

Máquina de estados: `PENDING` (só em memória) → `PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`;
`PENDING_REFERENCE` → `PROCESSED | REJECTED | FAILED` (ou reagendamento). Os terminais não mudam:
no domínio (`InvalidTransactionStateError`) e no banco (trigger `trg_wager_transaction_guard`).

Taxonomia de códigos: [contracts/failure-codes.md](specs/001-distributed-wagering-processor/contracts/failure-codes.md).

## 9. Autenticação e autorização

Autenticação **não foi implementada** (não pontua e o prazo era curto); **autorização foi**.

- **Autorização (implementada e testada)**: o `providerId` do corpo precisa ser igual à identidade
  do chamador. É regra de domínio e vale qualquer que seja o mecanismo de autenticação.
- **Ponto de extensão**: a identidade vem da porta `ProviderIdentity`. O adaptador atual,
  `devProviderIdentity` (header `X-Provider-Id`), é **inseguro e só para desenvolvimento**.
- **Desenho para produção**: Keycloak (ou Zitadel) com o fluxo OAuth 2.0 **Client Credentials**
  (máquina-a-máquina: cada provedor tem `client_id`/`client_secret`). O provedor obtém um JWT e o
  envia em `Authorization: Bearer`; a API valida a assinatura localmente com o JWKS do IdP (sem
  chamar o IdP por requisição), confere `exp`, `aud` e `iss`, e usa `azp`/`client_id` como
  `providerId`. Troca-se só o adaptador; o domínio não muda.
- Health checks ficam abertos; a fila é tratada como canal interno confiável, mas o conteúdo passa
  pelas mesmas validações de domínio.

## 10. Invariantes no schema

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)`, `CHECK (balance_after >= 0)` |
| Uma wallet por jogador + moeda | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única | índice único parcial `ux_reversal_once` |
| Um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Transação terminal imutável; campos de negócio imutáveis; sem `DELETE` | trigger `trg_wager_transaction_guard` |
| Valor > 0 (≥ 0 em LOSS); REFUND/ROLLBACK com referência | `CHECK`s em `wager_transaction` |

## 11. Observabilidade

- Logs JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`
  propagados por `AsyncLocalStorage`. Campos monetários e payloads são **removidos** (redact).
  `X-Correlation-Id` é aceito ou gerado e devolvido.
- Métricas (`GET /metrics`): `wager_transactions_total{status,kind}`,
  `idempotency_duplicates_total{channel}`, `retries_total{component}`, `dlq_messages`,
  `wallet_lock_conflicts_total`, `outbox_lag_seconds`, `processing_duration_seconds`,
  `reconciliation_divergences_total`, `sqs_messages_total{result}`.
- `GET /health/live` (processo) e `GET /health/ready` (Postgres + SQS). O ORM conecta sob demanda,
  então o processo sobe e responde *live* mesmo com o banco fora.
- Reconciliação: divergência é logada, contada em métrica e sinalizada (`consistent: false`);
  **nunca** corrigida automaticamente.

## 12. Teste de carga

Ambiente: notebook Windows 10, Docker Desktop (Postgres 16 e LocalStack em containers), **uma**
instância Bun rodando no host, 32 clientes concorrentes, 50 wallets, 15 s, operações `BET`/`WIN`
de R$ 1,00, cada uma com chave única.

| Cenário | Requisições | Throughput | p50 | p95 | p99 | Erros | Lock timeouts | Outbox lag máx. |
|---|---|---|---|---|---|---|---|---|
| 20 % do tráfego numa única wallet (hot wallet) | 565 | 33 req/s | 545 ms | 3 535 ms | 4 500 ms | 0 % | 0 | 0,63 s |
| Tráfego espalhado (sem hot wallet) | 1 074 | 69 req/s | 393 ms | 903 ms | 1 972 ms | 0 % | 0 | 0,63 s |

Depois de cada execução, as 50 wallets reconciliaram (saldo = ledger).

Análise:

- **A hot wallet domina a cauda**: as operações dela são serializadas pelo lock da linha (por
  definição: cada uma depende do saldo deixado pela anterior). Com 20 % do tráfego numa linha, a
  fila dessa wallet empurra o p95 de 0,9 s para 3,5 s e reduz o throughput à metade. É o
  trade-off esperado do lock pessimista, e é por isso que ele existe.
- **O número absoluto é baixo por causa do ambiente**, não da estratégia: cada operação faz ~10
  idas ao banco (lock, inbox, 2 buscas de idempotência, referência, inserts, update da wallet,
  outbox, wake de pendentes), e cada ida atravessa a rede virtual do Docker Desktop no Windows. O
  pool de 20 conexões para 32 clientes também enfileira.
- Melhorias possíveis, por ordem de impacto: rodar no Linux/mesma rede do banco; juntar as buscas
  de idempotência numa query; inserir em lote no flush; escalar horizontalmente (mais instâncias
  ajudam wallets diferentes, não a hot wallet); para hot wallets extremas, sharding de saldo ou
  fila dedicada por wallet.
- Não houve `lock_timeout` (fila máxima abaixo de 5 s) nem erro.

## 13. Limitações conhecidas

- **BET atrasada depois de ROLLBACK expirado**: se um provedor envia BET, sofre timeout e manda
  ROLLBACK, e a BET chega depois do prazo de 1 h, o ROLLBACK já foi rejeitado
  (`REFERENCE_NOT_FOUND`) e a BET é debitada. O prazo longo reduz a chance. Mitigação futura: ao
  chegar uma BET, verificar se existe reversão expirada apontando para ela e rejeitá-la.
- **Ordem de eventos**: dois publishers podem publicar eventos da mesma wallet fora de ordem.
  `WalletBalanceChanged` carrega `walletVersion` para o consumidor ordenar.
- **A transação da outbox fica aberta durante o `SendMessage`** (lote de no máximo 10). É simples
  e seguro; com SQS lento aumenta o tempo de lock das linhas da outbox (não das wallets).
- **Ledger de entrada simples** (não partidas dobradas).
- **Autenticação**: só o adaptador de desenvolvimento (ver §9).
- **SIGTERM no Windows**: não existe sinal real; o desligamento gracioso é garantido em Linux.

## 14. Verificação das falhas eliminatórias

| Falha eliminatória | Como é evitada | Prova |
|---|---|---|
| `number` para dinheiro | `Money` com `bigint`; contratos em string; `NUMERIC` no banco | `money.test.ts` |
| Saldo negativo por race | lock por wallet + `CHECK` no banco | `races.test.ts` (100/80/80 × 10, 3 instâncias) |
| Débito ou crédito duplicado | idempotência persistente + dupla unicidade + inbox + reversão única | 50× paralelo, redelivery, REFUND+ROLLBACK simultâneos |
| Idempotência só em memória | tudo no Postgres | replay após reinício, entre instâncias |
| Correto só com uma instância | garantias no banco; testes com 3 processos | `races.test.ts`, `crash-recovery.test.ts` |
| Evento antes do commit | outbox na mesma transação; publisher separado | `crash-recovery.test.ts` |
| Ledger não auditável | append-only com triggers; reconciliação | `schema-constraints.test.ts` |
| Testes só com mocks | Postgres e LocalStack reais, processos reais | todos os testes de integração e concorrência |
