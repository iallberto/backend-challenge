import { beforeAll, describe, expect, test } from "bun:test";
import { createWallet, getJson, submit, type Api } from "../support/api";
import { db, uuid } from "../support/infra";
import { sharedInstance } from "../support/instances";

let api: Api;
beforeAll(async () => {
  api = await sharedInstance();
});

describe("Consultas (US8)", () => {
  test("transação por id interno e por (providerId, externalTransactionId) devolvem o mesmo registro", async () => {
    const w = await createWallet(api, "50.00");
    const r = await submit(api, w, { kind: "BET", amount: "5.00" });
    const byId = await getJson(api, `/wagering/transactions/${r.body.transactionId}`);
    const byExt = await getJson(api, `/providers/provider-a/wagering/transactions/${r.externalTransactionId}`);
    expect(byId.status).toBe(200);
    expect(byExt.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({ kind: "BET", status: "PROCESSED", money: { amount: "5.00", currency: "BRL" } });
    expect((await getJson(api, `/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect((await getJson(api, `/wallets/${uuid()}`)).status).toBe(404);
  });

  test("extrato paginado por cursor opaco, sem repetição nem lacuna com inserções no meio", async () => {
    const w = await createWallet(api, "1000.00");
    for (let i = 0; i < 6; i++) await submit(api, w, { kind: "BET", amount: "1.00" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const q: string = cursor ? `?limit=3&cursor=${cursor}` : "?limit=3";
      const r = await getJson(api, `/wallets/${w.id}/ledger${q}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((i: { id: string }) => i.id));
      cursor = r.body.nextCursor;
      if (page++ === 0) await submit(api, w, { kind: "WIN", amount: "2.00" }); // chega no meio
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(8); // OPENING + 6 BET + WIN
    expect((await getJson(api, `/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await getJson(api, `/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
  });
});

describe("Reconciliação (US8)", () => {
  test("consistente após operações", async () => {
    const w = await createWallet(api, "100.00");
    await submit(api, w, { kind: "BET", amount: "30.00" });
    await submit(api, w, { kind: "WIN", amount: "12.50" });
    const r = await getJson(api, `/wallets/${w.id}/reconciliation`, { method: "POST" });
    expect(r.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: "82.50", currency: "BRL" },
      calculatedBalance: { amount: "82.50", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test("divergência injetada é sinalizada, contabilizada em métrica e NÃO corrigida", async () => {
    const w = await createWallet(api, "100.00");
    // corrompe o saldo materializado por fora da aplicação
    await db`UPDATE wallet SET balance = 999.00 WHERE id = ${w.id}`;
    const r = await getJson(api, `/wallets/${w.id}/reconciliation`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ consistent: false, difference: { amount: "899.00" } });
    const [row] = await db`SELECT balance::text AS b FROM wallet WHERE id = ${w.id}`;
    expect(row.b).toBe("999.00");
    const metrics = await (await fetch(`${api.url}/metrics`)).text();
    expect(metrics).toMatch(/reconciliation_divergences_total [1-9]/);
  });
});
