import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWallet, getJson, submit, type Api } from "../support/api";
import { assertReconciled, db, eventually, uuid } from "../support/infra";
import { type Instance, sharedInstance, startInstance } from "../support/instances";
import { DLQ, drainUntil, sendRaw, sendWager, wagerMessage } from "../support/queue";

/*
 * Consumidor SQS contra o LocalStack real. A instância compartilhada não consome a fila;
 * este arquivo sobe a(s) própria(s).
 */

let api: Api;
let consumer: Instance;
beforeAll(async () => {
  api = await sharedInstance();
  consumer = await startInstance({ LOCK_TIMEOUT_MS: "500" });
});
afterAll(async () => {
  await consumer?.stop();
});

const txByExternal = (ext: string) =>
  db`SELECT id, status, failure_code, result_balance::text AS balance FROM wager_transaction WHERE external_transaction_id = ${ext}`;

describe("Consumidor SQS (US6)", () => {
  test("mensagem é processada pelo mesmo caso de uso da entrada HTTP, com inbox gravada", async () => {
    const w = await createWallet(api, "100.00");
    const m = await sendWager(w, { kind: "BET", amount: "30.00" });
    const [tx] = await eventually(async () => {
      const rows = await txByExternal(m.externalTransactionId);
      return rows.length ? rows : undefined;
    });
    expect(tx).toMatchObject({ status: "PROCESSED", balance: "70.00" });
    const inbox = await db`SELECT consumer_name FROM inbox_message WHERE message_id = ${m.message.messageId}`;
    expect(inbox).toEqual([{ consumer_name: "wager-transactions-consumer" }]);
    await assertReconciled(w.id);
  });

  test("redelivery do mesmo messageId não duplica o efeito (inbox)", async () => {
    const w = await createWallet(api, "100.00");
    const m = wagerMessage(w, { kind: "BET", amount: "10.00" });
    for (let i = 0; i < 3; i++) await sendRaw(JSON.stringify(m.message), w.id);
    await eventually(async () => (await txByExternal(m.externalTransactionId)).length === 1);
    await Bun.sleep(2_000); // tempo para as cópias serem consumidas
    expect(await txByExternal(m.externalTransactionId)).toHaveLength(1);
    expect((await assertReconciled(w.id)).balance).toBe("90.00");
  });

  test("mesma operação por HTTP e pela fila ao mesmo tempo → um único efeito", async () => {
    const w = await createWallet(api, "100.00");
    const ext = `both-${uuid()}`;
    await Promise.all([
      sendWager(w, { kind: "BET", amount: "20.00", externalTransactionId: ext }),
      submit(api, w, { kind: "BET", amount: "20.00", externalTransactionId: ext }),
    ]);
    await eventually(async () => {
      const inbox = await db`SELECT 1 FROM inbox_message i JOIN wager_transaction t ON t.payload_hash = i.payload_hash
                              WHERE t.external_transaction_id = ${ext}`;
      return inbox.length > 0;
    });
    expect(await txByExternal(ext)).toHaveLength(1);
    expect((await assertReconciled(w.id)).balance).toBe("80.00");
  });

  test("rejeição de negócio e OPENING pela fila são confirmados (ack) e não vão para a DLQ", async () => {
    const w = await createWallet(api, "5.00");
    const rejected = await sendWager(w, { kind: "BET", amount: "50.00" });
    const opening = await sendWager(w, { kind: "OPENING", amount: "50.00" });
    await eventually(async () => (await txByExternal(rejected.externalTransactionId))[0]?.status === "REJECTED");
    await Bun.sleep(1_500);
    expect(await txByExternal(opening.externalTransactionId)).toHaveLength(0);
    expect((await assertReconciled(w.id)).balance).toBe("5.00");
  });

  test("mensagem ilegível vai para a DLQ depois do limite de recebimentos", async () => {
    const marker = `garbage-${uuid()}`;
    await sendRaw(`{not json ${marker}`, `g-${marker}`);
    const found = await drainUntil(DLQ, (body) => body.includes(marker), 60_000);
    expect(found.length).toBeGreaterThan(0);
  });

  test("falha transitória (lock timeout) → retry com backoff, depois processa uma vez", async () => {
    const w = await createWallet(api, "100.00");
    let ext = "";
    await db.begin(async (tx) => {
      await tx`SELECT id FROM wallet WHERE id = ${w.id} FOR UPDATE`;
      ext = (await sendWager(w, { kind: "BET", amount: "15.00" })).externalTransactionId;
      await Bun.sleep(3_000); // consumidor tenta, estoura lock_timeout (500 ms) e reagenda
      expect(await txByExternal(ext)).toHaveLength(0);
    });
    await eventually(async () => (await txByExternal(ext))[0]?.status === "PROCESSED", { timeoutMs: 20_000 });
    const metrics = await (await fetch(`${consumer.url}/metrics`)).text();
    expect(metrics).toMatch(/retries_total\{component="sqs_consumer"\} [1-9]/);
    expect(metrics).toMatch(/wallet_lock_conflicts_total [1-9]/);
    expect((await assertReconciled(w.id)).balance).toBe("85.00");
  });

  test("SIGTERM: termina o que está em andamento; nada se perde nem duplica", async () => {
    const w = await createWallet(api, "1000.00");
    const sent = await Promise.all(Array.from({ length: 8 }, () => sendWager(w, { kind: "BET", amount: "1.00" })));
    await Bun.sleep(300);
    const code = await consumer.stop();
    // No Windows não há SIGTERM real (o processo é terminado à força); a saída 0 do
    // desligamento gracioso só é verificável em Linux (Docker/CI). A garantia de
    // "nada perdido, nada duplicado" vale nos dois casos e é verificada abaixo.
    if (process.platform !== "win32") expect(code).toBe(0);
    consumer = await startInstance({ LOCK_TIMEOUT_MS: "500" });
    await eventually(
      async () => {
        const rows = await db`SELECT COUNT(*)::int AS n FROM wager_transaction WHERE wallet_id = ${w.id} AND kind = 'BET'`;
        return rows[0].n === sent.length;
      },
      { timeoutMs: 30_000, label: "all messages processed after restart" },
    );
    expect((await assertReconciled(w.id)).balance).toBe("992.00");
  });
});

describe("Erro permanente com banco acessível → FAILED (FR-032a)", () => {
  let faulty: Instance;
  beforeAll(async () => {
    await consumer.stop();
    faulty = await startInstance({ FAULT_INJECTION: "permanent_error_in_use_case" });
  });
  afterAll(async () => {
    await faulty?.stop();
    consumer = await startInstance({ LOCK_TIMEOUT_MS: "500" });
  });

  test("via fila: grava FAILED + evento e confirma a mensagem", async () => {
    const w = await createWallet(api, "100.00");
    const m = await sendWager(w, { kind: "BET", amount: "10.00" });
    const [tx] = await eventually(async () => {
      const rows = await txByExternal(m.externalTransactionId);
      return rows.length ? rows : undefined;
    });
    expect(tx).toMatchObject({ status: "FAILED", failure_code: "INTERNAL_ERROR" });
    const events = await db`SELECT event_type FROM outbox_message WHERE aggregate_id = ${tx.id}`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["WagerTransactionFailed"]);
    expect((await assertReconciled(w.id)).balance).toBe("100.00");
  });

  test("via HTTP: 500 com status FAILED; replay repete o 500", async () => {
    const w = await createWallet(api, "100.00");
    const ext = `fail-${uuid()}`;
    const r = await submit(faulty, w, { kind: "BET", amount: "10.00", externalTransactionId: ext });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ status: "FAILED", failureCode: "INTERNAL_ERROR" });
    const again = await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: ext });
    expect(again.status).toBe(500);
    expect(again.body.idempotentReplay).toBe(true);
    expect((await getJson(api, `/wallets/${w.id}`)).body.balance.amount).toBe("100.00");
  });
});
