import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SQL } from "bun";

/*
 * Infraestrutura REAL dos testes: o PostgreSQL e o LocalStack do docker-compose.
 * Nada aqui é mock (Constituição VII, README §13).
 */

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:55432/wagering";
export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? "http://localhost:4566";

export const db = new SQL(DATABASE_URL);

export const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: SQS_ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

export async function queueUrl(name: string): Promise<string> {
  const r = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  return r.QueueUrl!;
}

export const uuid = (): string => crypto.randomUUID();

/** Espera até a condição ser verdadeira (sem sleep fixo). */
export async function eventually<T>(
  fn: () => Promise<T | undefined | null | false>,
  { timeoutMs = 20_000, intervalMs = 100, label = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}

/** Invariante final de todos os testes: saldo materializado == saldo reconstruído pelo ledger. */
export async function assertReconciled(walletId: string): Promise<{ balance: string; entries: number }> {
  const [row] = await db`
    SELECT w.balance::text AS stored,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS calculated,
           COUNT(l.id)::int AS entries,
           MIN(l.balance_after)::text AS min_after
      FROM wallet w LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
     WHERE w.id = ${walletId}
     GROUP BY w.balance`;
  if (!row) throw new Error(`wallet ${walletId} not found`);
  if (Number(row.stored) !== Number(row.calculated)) {
    throw new Error(`wallet ${walletId} diverged: stored=${row.stored} ledger=${row.calculated}`);
  }
  if (Number(row.stored) < 0 || (row.min_after !== null && Number(row.min_after) < 0)) {
    throw new Error(`wallet ${walletId} went negative`);
  }
  return { balance: row.stored, entries: row.entries };
}

export async function countRows(table: "wallet_ledger_entry", walletId: string): Promise<number>;
export async function countRows(table: string, walletId: string): Promise<number> {
  const [r] = await db.unsafe(`SELECT COUNT(*)::int AS n FROM ${table} WHERE wallet_id = $1`, [walletId]);
  return r.n;
}

export async function transactionsOf(walletId: string) {
  return db`SELECT id, kind, status, failure_code, external_transaction_id, amount::text AS amount
              FROM wager_transaction WHERE wallet_id = ${walletId} ORDER BY created_at`;
}
