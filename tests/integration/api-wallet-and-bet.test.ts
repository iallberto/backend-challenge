import { beforeAll, describe, expect, test } from "bun:test";
import { createWallet, getJson, submit, submitRaw, wagerBody, type Api } from "../support/api";
import { assertReconciled, countRows, db, uuid } from "../support/infra";
import { sharedInstance } from "../support/instances";

let api: Api;
beforeAll(async () => {
  api = await sharedInstance();
});

describe("POST /wallets (US1)", () => {
  test("saldo inicial gera OPENING + crédito no ledger, versão 1, atomicamente", async () => {
    const w = await createWallet(api, "1000.00");
    const { body } = await getJson(api, `/wallets/${w.id}`);
    expect(body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(body.version).toBe(1);
    const txs = await db`SELECT kind, status FROM wager_transaction WHERE wallet_id = ${w.id}`;
    expect(txs).toEqual([{ kind: "OPENING", status: "PROCESSED" }]);
    const outbox = await db`SELECT event_type FROM outbox_message WHERE aggregate_id = ${w.id}`;
    expect(outbox.map((r: { event_type: string }) => r.event_type)).toEqual(["WalletBalanceChanged"]);
    expect(await assertReconciled(w.id)).toEqual({ balance: "1000.00", entries: 1 });
  });

  test("saldo zero não gera lançamento", async () => {
    const w = await createWallet(api, "0.00");
    expect(await assertReconciled(w.id)).toEqual({ balance: "0.00", entries: 0 });
  });

  test("duplicata (mesmo jogador + moeda) é 409; outra moeda é permitida", async () => {
    const playerId = uuid();
    const post = (currency: string) =>
      getJson(api, "/wallets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId, initialBalance: { amount: "10.00", currency } }),
      });
    expect((await post("BRL")).status).toBe(201);
    const dup = await post("BRL");
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_ALREADY_EXISTS");
    expect((await post("USD")).status).toBe(201);
  });

  test.each(["-1.00", "1e3", "10.001", "NaN", ""])("saldo inicial inválido %p → 400 INVALID_MONEY", async (amount) => {
    const r = await getJson(api, "/wallets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: uuid(), initialBalance: { amount, currency: "BRL" } }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_MONEY");
  });
});

describe("BET (US2)", () => {
  test("processa, debita, incrementa versão e grava ledger + outbox", async () => {
    const w = await createWallet(api, "1000.00");
    const r = await submit(api, w, { kind: "BET", amount: "25.00" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00", currency: "BRL" }, idempotentReplay: false });
    expect((await getJson(api, `/wallets/${w.id}`)).body.version).toBe(2);
    const events = await db`SELECT event_type FROM outbox_message WHERE payload->'data'->>'transactionId' = ${r.body.transactionId!}`;
    expect(events.map((e: { event_type: string }) => e.event_type).sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await assertReconciled(w.id);
  });

  test("saldo insuficiente → 422, sem ledger e sem mudar versão", async () => {
    const w = await createWallet(api, "10.00");
    const r = await submit(api, w, { kind: "BET", amount: "25.00" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
    expect((await getJson(api, `/wallets/${w.id}`)).body.version).toBe(1);
    expect(await countRows("wallet_ledger_entry", w.id)).toBe(1);
    await assertReconciled(w.id);
  });

  test("BET de 0.00 → 400 INVALID_MONEY sem gravar nada (FR-002a)", async () => {
    const w = await createWallet(api, "10.00");
    const r = await submit(api, w, { kind: "BET", amount: "0.00" });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("INVALID_MONEY");
    expect(await db`SELECT 1 FROM wager_transaction WHERE external_transaction_id = ${r.externalTransactionId}`).toHaveLength(0);
  });

  test("OPENING enviado de fora → 400 OPENING_NOT_ALLOWED", async () => {
    const w = await createWallet(api, "10.00");
    const r = await submit(api, w, { kind: "OPENING", amount: "5.00" });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("OPENING_NOT_ALLOWED");
  });

  test("moeda diferente → 422 CURRENCY_MISMATCH; wallet inexistente → 422 WALLET_NOT_FOUND", async () => {
    const w = await createWallet(api, "10.00");
    expect((await submit(api, w, { kind: "BET", amount: "1.00", currency: "USD" })).body.failureCode).toBe("CURRENCY_MISMATCH");
    const ghost = { id: uuid(), playerId: w.playerId };
    const r = await submit(api, ghost, { kind: "BET", amount: "1.00" });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe("WALLET_NOT_FOUND");
  });

  test("provider do corpo ≠ chamador → 403 e NADA gravado (não envenena a chave)", async () => {
    const w = await createWallet(api, "50.00");
    const forged = await submit(api, w, { kind: "BET", amount: "5.00", providerId: "provider-b", callerProviderId: "provider-a", externalTransactionId: "tx-legit" + uuid() });
    expect(forged.status).toBe(403);
    expect(forged.body.error?.code).toBe("PROVIDER_MISMATCH");
    // o dono legítimo envia a mesma chave depois e é processado normalmente
    const legit = await submit(api, w, {
      kind: "BET",
      amount: "5.00",
      providerId: "provider-b",
      externalTransactionId: forged.externalTransactionId,
    });
    expect(legit.status).toBe(201);
    expect(legit.body.idempotentReplay).toBe(false);
  });

  test("payload malformado → 400 INVALID_PAYLOAD; sem Idempotency-Key → 400", async () => {
    const w = await createWallet(api, "10.00");
    const { body } = wagerBody(w, { kind: "BET", amount: "1.00" });
    expect((await submitRaw(api, { ...body, walletId: "not-a-uuid" }, "k-" + uuid(), "provider-a")).body.error?.code).toBe("INVALID_PAYLOAD");
    const noKey = await submitRaw(api, body, undefined, "provider-a");
    expect(noKey.status).toBe(400);
    expect(noKey.body.error?.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });
});

describe("Idempotência (US3)", () => {
  test("replay devolve o resultado original, com o saldo daquele momento e o mesmo código", async () => {
    const w = await createWallet(api, "100.00");
    const first = await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: "replay-" + uuid() });
    await submit(api, w, { kind: "BET", amount: "30.00" }); // saldo muda depois
    const again = await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: first.externalTransactionId });
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(again.body.balance?.amount).toBe("90.00");
    await assertReconciled(w.id);
  });

  test("replay de uma rejeição repete o 422", async () => {
    const w = await createWallet(api, "1.00");
    const ext = "rej-" + uuid();
    const a = await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: ext });
    const b = await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: ext });
    expect([a.status, b.status]).toEqual([422, 422]);
    expect(b.body.idempotentReplay).toBe(true);
  });

  test("mesma chave com payload diferente → 409 IDEMPOTENCY_KEY_CONFLICT", async () => {
    const w = await createWallet(api, "100.00");
    const ext = "conf-" + uuid();
    await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: ext });
    const r = await submit(api, w, { kind: "BET", amount: "11.00", externalTransactionId: ext });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    await assertReconciled(w.id);
  });

  test("mesmo id externo com outra chave → 409 EXTERNAL_ID_CONFLICT, sem segundo débito (FR-028a)", async () => {
    const w = await createWallet(api, "100.00");
    const ext = "ext-" + uuid();
    await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: ext });
    const r = await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: ext, idempotencyKey: `retry-v2:${ext}` });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("EXTERNAL_ID_CONFLICT");
    expect((await assertReconciled(w.id)).balance).toBe("90.00");
  });

  test("'25' e '25.00' com a mesma chave são replay (hash canônico)", async () => {
    const w = await createWallet(api, "100.00");
    const ext = "canon-" + uuid();
    await submit(api, w, { kind: "BET", amount: "25.00", externalTransactionId: ext });
    const r = await submit(api, w, { kind: "BET", amount: "25", externalTransactionId: ext });
    expect(r.body.idempotentReplay).toBe(true);
  });
});

describe("WIN e LOSS (US4)", () => {
  test("WIN credita (inclusive sem BET: free spin); LOSS não move saldo nem versão", async () => {
    const w = await createWallet(api, "100.00");
    expect((await submit(api, w, { kind: "WIN", amount: "50.00" })).body.balance?.amount).toBe("150.00");
    const before = (await getJson(api, `/wallets/${w.id}`)).body.version;
    const loss = await submit(api, w, { kind: "LOSS", amount: "0.00" });
    expect(loss.status).toBe(201);
    expect(loss.body.status).toBe("PROCESSED");
    expect((await getJson(api, `/wallets/${w.id}`)).body.version).toBe(before);
    const events = await db`SELECT event_type FROM outbox_message WHERE aggregate_id = ${loss.body.transactionId!}`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["WagerTransactionProcessed"]);
    expect(await assertReconciled(w.id)).toEqual({ balance: "150.00", entries: 2 });
  });

  test("WIN referenciando BET de outra rodada → 422 REFERENCE_MISMATCH", async () => {
    const w = await createWallet(api, "100.00");
    const bet = await submit(api, w, { kind: "BET", amount: "10.00", roundId: "r-a" });
    const win = await submit(api, w, { kind: "WIN", amount: "20.00", reference: bet.externalTransactionId, roundId: "r-b" });
    expect(win.body.failureCode).toBe("REFERENCE_MISMATCH");
  });
});

describe("REFUND e ROLLBACK (US5)", () => {
  test("REFUND devolve; segunda reversão (de qualquer tipo) é rejeitada (FR-049)", async () => {
    const w = await createWallet(api, "100.00");
    const bet = await submit(api, w, { kind: "BET", amount: "25.00" });
    const refund = await submit(api, w, { kind: "REFUND", amount: "25.00", reference: bet.externalTransactionId });
    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    const rollback = await submit(api, w, { kind: "ROLLBACK", amount: "25.00", reference: bet.externalTransactionId });
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    await assertReconciled(w.id);
  });

  test("cadeia BET → REFUND → ROLLBACK do REFUND → novo REFUND rejeitado; saldo 75, 3 lançamentos de aposta", async () => {
    const w = await createWallet(api, "100.00");
    const bet = await submit(api, w, { kind: "BET", amount: "25.00" });
    const refund = await submit(api, w, { kind: "REFUND", amount: "25.00", reference: bet.externalTransactionId });
    const rb = await submit(api, w, { kind: "ROLLBACK", amount: "25.00", reference: refund.externalTransactionId });
    expect(rb.body.balance?.amount).toBe("75.00");
    const again = await submit(api, w, { kind: "REFUND", amount: "25.00", reference: bet.externalTransactionId });
    expect(again.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await assertReconciled(w.id)).toEqual({ balance: "75.00", entries: 4 });
  });

  test("ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)", async () => {
    const w = await createWallet(api, "0.00");
    const win = await submit(api, w, { kind: "WIN", amount: "50.00" });
    await submit(api, w, { kind: "BET", amount: "45.00" });
    const rb = await submit(api, w, { kind: "ROLLBACK", amount: "50.00", reference: win.externalTransactionId });
    expect(rb.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    expect((await assertReconciled(w.id)).balance).toBe("5.00");
  });

  test("valor diferente → REVERSAL_AMOUNT_MISMATCH; REFUND de WIN → INVALID_REFERENCE_KIND; sem referência → 400", async () => {
    const w = await createWallet(api, "100.00");
    const bet = await submit(api, w, { kind: "BET", amount: "25.00" });
    expect((await submit(api, w, { kind: "REFUND", amount: "20.00", reference: bet.externalTransactionId })).body.failureCode).toBe("REVERSAL_AMOUNT_MISMATCH");
    const win = await submit(api, w, { kind: "WIN", amount: "5.00" });
    expect((await submit(api, w, { kind: "REFUND", amount: "5.00", reference: win.externalTransactionId })).body.failureCode).toBe("INVALID_REFERENCE_KIND");
    const noRef = await submit(api, w, { kind: "REFUND", amount: "5.00" });
    expect(noRef.status).toBe(400);
    expect(noRef.body.error?.code).toBe("MISSING_REFERENCE");
  });

  test("REFUND de BET já rejeitada → REFERENCE_NOT_PROCESSED imediato", async () => {
    const w = await createWallet(api, "1.00");
    const bet = await submit(api, w, { kind: "BET", amount: "25.00" });
    const r = await submit(api, w, { kind: "REFUND", amount: "25.00", reference: bet.externalTransactionId });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe("REFERENCE_NOT_PROCESSED");
  });
});
