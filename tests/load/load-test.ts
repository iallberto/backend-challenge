/**
 * Teste de carga (diferencial opcional). Uso:
 *   BASE_URL=http://localhost:3100 DURATION_S=20 CONCURRENCY=32 WALLETS=50 bun run test:load
 *
 * Mede throughput, p50/p95/p99, taxa de erro, conflitos de concorrência (503 por lock_timeout)
 * e o outbox lag reportado pela própria aplicação. Sem meta de RPS: o objetivo é observar.
 */
export {};

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const DURATION_S = Number(process.env.DURATION_S ?? 20);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const WALLETS = Number(process.env.WALLETS ?? 50);
/** Fração de requisições que vão para uma única "hot wallet". */
const HOT_RATIO = Number(process.env.HOT_RATIO ?? 0.2);

interface W {
  id: string;
  playerId: string;
}

async function createWallet(): Promise<W> {
  const playerId = crypto.randomUUID();
  const r = await fetch(`${BASE_URL}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: "100000.00", currency: "BRL" } }),
  });
  const body = (await r.json()) as { id: string };
  return { id: body.id, playerId };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function metric(name: string): Promise<number> {
  const text = await (await fetch(`${BASE_URL}/metrics`)).text();
  const line = text.split("\n").find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(" ")[1]) : Number.NaN;
}

const wallets = await Promise.all(Array.from({ length: WALLETS }, createWallet));
const hot = wallets[0]!;
const latencies: number[] = [];
const statusCounts = new Map<number, number>();
let maxLag = 0;
const deadline = Date.now() + DURATION_S * 1000;

const lagSampler = setInterval(async () => {
  const lag = await metric("outbox_lag_seconds").catch(() => 0);
  if (lag > maxLag) maxLag = lag;
}, 500);

async function worker(): Promise<void> {
  while (Date.now() < deadline) {
    const w = Math.random() < HOT_RATIO ? hot : wallets[1 + Math.floor(Math.random() * (wallets.length - 1))]!;
    const ext = `load-${crypto.randomUUID()}`;
    const kind = Math.random() < 0.7 ? "BET" : "WIN";
    const started = performance.now();
    try {
      const r = await fetch(`${BASE_URL}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `provider-load:${ext}`, "x-provider-id": "provider-load" },
        body: JSON.stringify({
          providerId: "provider-load",
          externalTransactionId: ext,
          playerId: w.playerId,
          walletId: w.id,
          roundId: "load",
          gameId: "load",
          kind,
          money: { amount: "1.00", currency: "BRL" },
        }),
      });
      await r.arrayBuffer();
      statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
    } catch {
      statusCounts.set(0, (statusCounts.get(0) ?? 0) + 1);
    }
    latencies.push(performance.now() - started);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const elapsed = (performance.now() - started) / 1000;
clearInterval(lagSampler);

const sorted = latencies.slice().sort((a, b) => a - b);
const total = latencies.length;
const errors = [...statusCounts.entries()].filter(([s]) => s === 0 || s >= 500).reduce((a, [, n]) => a + n, 0);
const report = {
  environment: { baseUrl: BASE_URL, durationS: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS, hotRatio: HOT_RATIO },
  requests: total,
  throughputRps: Math.round(total / elapsed),
  latencyMs: { p50: percentile(sorted, 50).toFixed(1), p95: percentile(sorted, 95).toFixed(1), p99: percentile(sorted, 99).toFixed(1) },
  statusCounts: Object.fromEntries(statusCounts),
  errorRate: `${((errors / Math.max(1, total)) * 100).toFixed(2)}%`,
  lockConflicts: await metric("wallet_lock_conflicts_total"),
  maxOutboxLagSeconds: maxLag,
};
console.log(JSON.stringify(report, null, 2));

// invariante final também sob carga
for (const w of wallets) {
  const r = (await (await fetch(`${BASE_URL}/wallets/${w.id}/reconciliation`, { method: "POST" })).json()) as { consistent: boolean };
  if (!r.consistent) {
    console.error(`wallet ${w.id} inconsistent after load`);
    process.exit(1);
  }
}
console.log(`reconciliation: ${wallets.length}/${wallets.length} wallets consistent`);
