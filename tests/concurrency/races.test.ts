import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWallet, submit, type Api } from "../support/api";
import { assertReconciled, countRows, db, transactionsOf, uuid } from "../support/infra";
import { type Instance, startInstance } from "../support/instances";

/*
 * Paralelismo REAL: requisições HTTP simultâneas contra processos reais, com o Postgres real
 * fazendo o controle de concorrência. Nada de mocks sequenciais (README §13).
 */

let instances: Instance[] = [];
let api: Api;
beforeAll(async () => {
  // três instâncias desde o início: os cenários abaixo valem com múltiplas instâncias
  instances = await Promise.all([1, 2, 3].map(() => startInstance({ CONSUMER_ENABLED: "false" })));
  api = instances[0]!;
});
afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop()));
});

const pick = (n: number) => instances[n % instances.length]!;

describe("Cenário obrigatório (seção 8)", () => {
  test.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    "rodada %i: saldo 100, duas BETs de 80 simultâneas → 1 PROCESSED, 1 INSUFFICIENT_FUNDS, saldo 20, 1 débito",
    async (round) => {
      const w = await createWallet(api, "100.00");
      const results = await Promise.all([
        submit(pick(round), w, { kind: "BET", amount: "80.00" }),
        submit(pick(round + 1), w, { kind: "BET", amount: "80.00" }),
      ]);
      const statuses = results.map((r) => r.body.status).sort();
      expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
      expect(results.find((r) => r.body.status === "REJECTED")!.body.failureCode).toBe("INSUFFICIENT_FUNDS");
      const ledger = await db`SELECT direction FROM wallet_ledger_entry WHERE wallet_id = ${w.id} AND direction = 'DEBIT'`;
      expect(ledger).toHaveLength(1);
      expect(await assertReconciled(w.id)).toEqual({ balance: "20.00", entries: 2 });
    },
  );
});

describe("Idempotência sob paralelismo", () => {
  test("a mesma aposta enviada 50 vezes em paralelo (em 3 instâncias) → um único débito", async () => {
    const w = await createWallet(api, "1000.00");
    const ext = `same-${uuid()}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(pick(i), w, { kind: "BET", amount: "10.00", externalTransactionId: ext })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.balance?.amount))).toEqual(new Set(["990.00"]));
    expect(await countRows("wallet_ledger_entry", w.id)).toBe(2);
    expect((await assertReconciled(w.id)).balance).toBe("990.00");
  });

  test("mesma chave com walletId diferente em paralelo → um efeito, o resto é conflito (guarda das constraints)", async () => {
    const a = await createWallet(api, "100.00");
    const b = await createWallet(api, "100.00");
    const ext = `cross-${uuid()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        submit(pick(i), i % 2 ? a : b, { kind: "BET", amount: "10.00", externalTransactionId: ext }),
      ),
    );
    const created = results.filter((r) => r.status === 201 && r.body.idempotentReplay === false);
    expect(created).toHaveLength(1);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    const balances = [(await assertReconciled(a.id)).balance, (await assertReconciled(b.id)).balance].sort();
    expect(balances).toEqual(["100.00", "90.00"].sort());
  });
});

describe("Hot wallet e wallets independentes", () => {
  test("40 operações mistas concorrentes na mesma wallet, em 3 instâncias: nunca negativa, ledger consistente", async () => {
    const w = await createWallet(api, "200.00");
    const ops = Array.from({ length: 40 }, (_, i) =>
      i % 4 === 0 ? { kind: "WIN", amount: "7.50" } : { kind: "BET", amount: "12.25" },
    );
    const results = await Promise.all(ops.map((op, i) => submit(pick(i), w, op)));
    expect(results.every((r) => [201, 422].includes(r.status))).toBe(true);
    const processed = await db`SELECT kind, amount::text AS amount FROM wager_transaction
                                WHERE wallet_id = ${w.id} AND status = 'PROCESSED' AND kind <> 'OPENING'`;
    const expected = processed.reduce(
      (acc: number, t: { kind: string; amount: string }) => acc + (t.kind === "WIN" ? 1 : -1) * Math.round(Number(t.amount) * 100),
      20_000,
    );
    const { balance } = await assertReconciled(w.id);
    expect(Math.round(Number(balance) * 100)).toBe(expected);
  });

  test("wallets distintas não esperam umas pelas outras: com A travada, B segue normalmente (SC-009)", async () => {
    const a = await createWallet(api, "100.00");
    const others = await Promise.all(Array.from({ length: 10 }, () => createWallet(api, "100.00")));
    let blockedA: Promise<unknown> | undefined;
    await db.begin(async (tx) => {
      // segura o lock da linha de A por fora, como uma transação longa faria
      await tx`SELECT id FROM wallet WHERE id = ${a.id} FOR UPDATE`;
      let aDone = false;
      blockedA = submit(api, a, { kind: "BET", amount: "1.00" }).then((r) => {
        aDone = true;
        return r;
      });
      const started = performance.now();
      const results = await Promise.all(
        others.flatMap((w) => Array.from({ length: 5 }, (_, i) => submit(pick(i), w, { kind: "BET", amount: "1.00" }))),
      );
      const elapsed = performance.now() - started;
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(aDone).toBe(false); // A continua esperando o lock...
      expect(elapsed).toBeLessThan(4_000); // ...enquanto 50 operações em outras wallets já terminaram
    });
    const ra = (await blockedA) as Awaited<ReturnType<typeof submit>>;
    expect([201, 503]).toContain(ra.status); // processa ao liberar, ou 503 se passou do lock_timeout
    for (const w of others) expect((await assertReconciled(w.id)).balance).toBe("95.00");
    await assertReconciled(a.id);
  });
});

describe("Reversões concorrentes", () => {
  test("REFUND e ROLLBACK da mesma BET ao mesmo tempo, em instâncias diferentes → só um aplicado", async () => {
    for (let round = 0; round < 5; round++) {
      const w = await createWallet(api, "100.00");
      const bet = await submit(api, w, { kind: "BET", amount: "30.00" });
      const [refund, rollback] = await Promise.all([
        submit(pick(round), w, { kind: "REFUND", amount: "30.00", reference: bet.externalTransactionId }),
        submit(pick(round + 1), w, { kind: "ROLLBACK", amount: "30.00", reference: bet.externalTransactionId }),
      ]);
      const outcomes = [refund.body.status, rollback.body.status].sort();
      expect(outcomes).toEqual(["PROCESSED", "REJECTED"]);
      expect([refund.body.failureCode, rollback.body.failureCode]).toContain("REFERENCE_ALREADY_REVERSED");
      expect((await assertReconciled(w.id)).balance).toBe("100.00");
    }
  });

  test("ROLLBACK entregue antes da BET, com 3 instâncias e o worker rodando em todas", async () => {
    const w = await createWallet(api, "100.00");
    const betExt = `ooo-${uuid()}`;
    const rb = await submit(pick(1), w, { kind: "ROLLBACK", amount: "60.00", reference: betExt });
    expect(rb.status).toBe(202);
    await submit(pick(2), w, { kind: "BET", amount: "60.00", externalTransactionId: betExt });
    const deadline = Date.now() + 15_000;
    let rows: Awaited<ReturnType<typeof transactionsOf>> = [] as never;
    while (Date.now() < deadline) {
      rows = await transactionsOf(w.id);
      if (rows.find((r: { kind: string }) => r.kind === "ROLLBACK")?.status === "PROCESSED") break;
      await Bun.sleep(100);
    }
    expect(rows.find((r: { kind: string }) => r.kind === "ROLLBACK")?.status).toBe("PROCESSED");
    expect(await assertReconciled(w.id)).toEqual({ balance: "100.00", entries: 3 });
  });
});
