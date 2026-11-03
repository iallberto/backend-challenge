import { beforeAll, describe, expect, test } from "bun:test";
import { createWallet, getJson, submit, type Api } from "../support/api";
import { assertReconciled, db, eventually } from "../support/infra";
import { sharedInstance } from "../support/instances";

/* A instância compartilhada usa backoff de 200 ms e prazo (TTL) de 6 s (FAST_ENV). */

let api: Api;
beforeAll(async () => {
  api = await sharedInstance();
});

const statusOf = async (transactionId: string) =>
  (await getJson(api, `/wagering/transactions/${transactionId}`)).body as { status: string; failureCode: string | null };

describe("Referências fora de ordem (US5, FR-022 a FR-023a)", () => {
  test("ROLLBACK antes da BET → 202; a BET chega e o ROLLBACK é aplicado; saldo final = inicial", async () => {
    const w = await createWallet(api, "100.00");
    const betExt = `late-bet-${crypto.randomUUID()}`;
    const rb = await submit(api, w, { kind: "ROLLBACK", amount: "40.00", reference: betExt });
    expect(rb.status).toBe(202);
    expect(rb.body.status).toBe("PENDING_REFERENCE");
    const events = await db`SELECT event_type FROM outbox_message WHERE aggregate_id = ${rb.body.transactionId!}`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["WagerTransactionPendingReference"]);

    await submit(api, w, { kind: "BET", amount: "40.00", externalTransactionId: betExt });
    await eventually(async () => (await statusOf(rb.body.transactionId!)).status === "PROCESSED", { label: "rollback applied" });
    expect(await assertReconciled(w.id)).toEqual({ balance: "100.00", entries: 3 });

    // replay de operação que estava pendente devolve o estado ATUAL (FR-026a)
    const replay = await submit(api, w, { kind: "ROLLBACK", amount: "40.00", reference: betExt, externalTransactionId: rb.externalTransactionId });
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
  });

  test("referência chega REJEITADA → REFERENCE_NOT_PROCESSED sem esperar o prazo", async () => {
    const w = await createWallet(api, "1.00");
    const betExt = `rej-bet-${crypto.randomUUID()}`;
    const refund = await submit(api, w, { kind: "REFUND", amount: "25.00", reference: betExt });
    expect(refund.status).toBe(202);
    const bet = await submit(api, w, { kind: "BET", amount: "25.00", externalTransactionId: betExt });
    expect(bet.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    const started = Date.now();
    const final = await eventually(async () => {
      const s = await statusOf(refund.body.transactionId!);
      return s.status === "REJECTED" ? s : undefined;
    });
    expect(final.failureCode).toBe("REFERENCE_NOT_PROCESSED");
    expect(Date.now() - started).toBeLessThan(5_000);
    await assertReconciled(w.id);
  });

  test("referência nunca chega → REFERENCE_NOT_FOUND após o prazo, com evento de rejeição", async () => {
    const w = await createWallet(api, "10.00");
    const pending = await submit(api, w, { kind: "WIN", amount: "5.00", reference: `never-${crypto.randomUUID()}` });
    expect(pending.status).toBe(202);
    const final = await eventually(
      async () => {
        const s = await statusOf(pending.body.transactionId!);
        return s.status === "REJECTED" ? s : undefined;
      },
      { timeoutMs: 20_000, label: "pending expiry" },
    );
    expect(final.failureCode).toBe("REFERENCE_NOT_FOUND");
    const [row] = await db`SELECT attempts FROM wager_transaction WHERE id = ${pending.body.transactionId!}`;
    expect(row.attempts).toBeGreaterThan(0);
    const events = await db`SELECT event_type FROM outbox_message WHERE aggregate_id = ${pending.body.transactionId!} ORDER BY occurred_at`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    expect((await assertReconciled(w.id)).balance).toBe("10.00");
  });
});
