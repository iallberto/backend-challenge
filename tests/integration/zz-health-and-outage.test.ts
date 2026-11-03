import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createWallet, getJson, submit, type Api } from "../support/api";
import { assertReconciled, eventually, uuid } from "../support/infra";
import { type Instance, sharedInstance } from "../support/instances";

/* Roda por último (prefixo zz): derruba e religa o Postgres do docker-compose. */

let api: Instance;
beforeAll(async () => {
  api = await sharedInstance();
});

const compose = (...args: string[]) =>
  Bun.spawnSync(["docker", "compose", ...args], { cwd: join(import.meta.dir, "..", ".."), stdout: "ignore", stderr: "ignore" });

describe("Health checks e observabilidade (US9)", () => {
  test("live e ready respondem sem autenticação; /metrics expõe as métricas mínimas", async () => {
    expect((await getJson(api, "/health/live")).body).toEqual({ status: "ok" });
    expect((await getJson(api, "/health/ready")).body).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
    const metrics = await (await fetch(`${api.url}/metrics`)).text();
    for (const name of [
      "wager_transactions_total",
      "idempotency_duplicates_total",
      "retries_total",
      "dlq_messages",
      "wallet_lock_conflicts_total",
      "outbox_lag_seconds",
      "processing_duration_seconds",
    ]) {
      expect(metrics).toContain(name);
    }
  });

  test("logs são JSON com campos de correlação e sem valores monetários", async () => {
    const w = await createWallet(api, "123.45");
    const correlationId = `corr-${uuid()}`;
    await fetch(`${api.url}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `provider-a:log-${correlationId}`,
        "x-provider-id": "provider-a",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: `log-${correlationId}`,
        playerId: w.playerId,
        walletId: w.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "7.77", currency: "BRL" },
      }),
    });
    const logPath = join(import.meta.dir, "..", ".logs", `instance-${api.port}.log`);
    const line = await eventually(async () => {
      const text = await Bun.file(logPath).text();
      return text.split("\n").find((l) => l.includes(correlationId));
    });
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ correlationId, walletId: w.id, providerId: "provider-a", level: "info" });
    expect(entry.transactionId).toBeDefined();
    expect(line).not.toContain("7.77");
    expect(line).not.toContain("123.45");
  });
});

describe("Postgres indisponível (FR-040b)", () => {
  test("live continua 200, ready vira 503, POST responde 503 sem gravar; ao voltar, o reenvio processa do zero", async () => {
    const w = await createWallet(api, "100.00");
    const ext = `outage-${uuid()}`;
    compose("stop", "postgres");
    try {
      expect((await getJson(api, "/health/live")).status).toBe(200);
      const ready = await getJson(api, "/health/ready");
      expect(ready.status).toBe(503);
      expect(ready.body.checks.postgres).toBe("down");
      const r = await fetch(`${api.url}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `provider-a:${ext}`, "x-provider-id": "provider-a" },
        body: JSON.stringify({
          providerId: "provider-a",
          externalTransactionId: ext,
          playerId: w.playerId,
          walletId: w.id,
          roundId: "r",
          gameId: "g",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("1");
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("SERVICE_UNAVAILABLE");
    } finally {
      compose("start", "postgres");
    }
    await eventually(async () => (await getJson(api, "/health/ready")).status === 200, { timeoutMs: 60_000, label: "postgres back" });
    const retry = await eventually(async () => {
      const res = await submit(api, w, { kind: "BET", amount: "10.00", externalTransactionId: ext });
      return res.status === 201 ? res : undefined;
    });
    expect(retry.body.idempotentReplay).toBe(false); // nada tinha sido gravado durante a falha
    expect((await assertReconciled(w.id)).balance).toBe("90.00");
  }, 120_000);
});
