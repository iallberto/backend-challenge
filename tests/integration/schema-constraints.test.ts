import "reflect-metadata";
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createOrm } from "../../src/infrastructure/persistence/orm";
import { DATABASE_URL, db, uuid } from "../support/infra";

/*
 * Constraints, índices e triggers testados direto via SQL: as garantias valem mesmo que o
 * código da aplicação tenha um bug (README §5.9).
 */

async function insertWallet(balance = "100.00") {
  const id = uuid();
  await db`INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES (${id}, ${uuid()}, 'BRL', ${balance}, 1, now(), now())`;
  return id;
}

async function insertTx(walletId: string, kind: string, status: string, opts: { ref?: string; refId?: string; amount?: string } = {}) {
  const id = uuid();
  const ext = `ext-${id}`;
  await db`INSERT INTO wager_transaction
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
     kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
     attempts, created_at, updated_at, processed_at)
    VALUES (${id}, 'p', ${ext}, ${"p:" + ext}, ${"0".repeat(64)}, ${walletId}, ${uuid()}, 'r', 'g',
            ${kind}, ${opts.amount ?? "10.00"}, 'BRL', ${opts.ref ?? null}, ${opts.refId ?? null}, ${status},
            ${status === "REJECTED" || status === "FAILED" ? "X" : null}, 0, now(), now(),
            ${status === "PROCESSED" ? new Date() : null})`;
  return { id, ext };
}

const rejects = async (p: Promise<unknown>, pattern: RegExp) => {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toMatch(pattern);
};

describe("constraints do schema", () => {
  test("saldo negativo é recusado pelo banco", async () => {
    const id = await insertWallet();
    await rejects(db`UPDATE wallet SET balance = -0.01 WHERE id = ${id}`, /ck_wallet_balance_non_negative/);
  });

  test("uma wallet por jogador + moeda", async () => {
    const player = uuid();
    await db`INSERT INTO wallet VALUES (${uuid()}, ${player}, 'BRL', 0, 1, now(), now())`;
    await rejects(db`INSERT INTO wallet VALUES (${uuid()}, ${player}, 'BRL', 0, 1, now(), now())`, /ux_wallet_player_currency/);
  });

  test("ledger: aritmética conferida, saldo após nunca negativo, imutável (UPDATE/DELETE/TRUNCATE)", async () => {
    const walletId = await insertWallet();
    const tx = await insertTx(walletId, "BET", "PROCESSED");
    await rejects(
      db`INSERT INTO wallet_ledger_entry (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (${uuid()}, ${walletId}, ${tx.id}, 'DEBIT', 10, 'BRL', 100, 95, now())`,
      /ck_ledger_balanced/,
    );
    const entryId = uuid();
    await db`INSERT INTO wallet_ledger_entry (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             VALUES (${entryId}, ${walletId}, ${tx.id}, 'DEBIT', 10, 'BRL', 100, 90, now())`;
    await rejects(
      db`INSERT INTO wallet_ledger_entry (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (${uuid()}, ${walletId}, ${tx.id}, 'DEBIT', 10, 'BRL', 90, 80, now())`,
      /ux_ledger_transaction_wallet/,
    );
    await rejects(db`UPDATE wallet_ledger_entry SET amount = 1 WHERE id = ${entryId}`, /append-only/);
    await rejects(db`DELETE FROM wallet_ledger_entry WHERE id = ${entryId}`, /append-only/);
    await rejects(db`TRUNCATE wallet_ledger_entry`, /append-only/);
  });

  test("transação terminal não muda; campos de negócio são imutáveis; não pode ser apagada", async () => {
    const walletId = await insertWallet();
    const done = await insertTx(walletId, "BET", "PROCESSED");
    await rejects(db`UPDATE wager_transaction SET status = 'REJECTED', failure_code = 'X', processed_at = NULL WHERE id = ${done.id}`, /terminal/);
    await rejects(db`DELETE FROM wager_transaction WHERE id = ${done.id}`, /cannot be deleted/);
    const pending = uuid();
    await db`INSERT INTO wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
               round_id, game_id, kind, amount, currency, reference_external_transaction_id, status, attempts, next_attempt_at,
               expires_at, created_at, updated_at)
             VALUES (${pending}, 'p', ${"pend-" + pending}, ${"k-" + pending}, ${"0".repeat(64)}, ${walletId}, ${uuid()}, 'r', 'g',
               'REFUND', 10, 'BRL', 'missing', 'PENDING_REFERENCE', 0, now(), now() + interval '1 hour', now(), now())`;
    await rejects(db`UPDATE wager_transaction SET amount = 11 WHERE id = ${pending}`, /immutable/);
    await db`UPDATE wager_transaction SET attempts = 1 WHERE id = ${pending}`; // agenda pode mudar
  });

  test("unicidade de idempotency_key e de (provider_id, external_transaction_id)", async () => {
    const walletId = await insertWallet();
    const a = await insertTx(walletId, "BET", "PROCESSED");
    await rejects(
      db`INSERT INTO wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, attempts, created_at, updated_at, processed_at)
         VALUES (${uuid()}, 'p', ${a.ext}, ${"other-key-" + a.id}, ${"0".repeat(64)}, ${walletId}, ${uuid()}, 'r', 'g', 'BET', 1, 'BRL',
           'PROCESSED', 0, now(), now(), now())`,
      /ux_wager_provider_external/,
    );
  });

  test("índice parcial: uma única reversão PROCESSED por referência, de qualquer tipo (FR-049)", async () => {
    const walletId = await insertWallet();
    const bet = await insertTx(walletId, "BET", "PROCESSED");
    await insertTx(walletId, "REFUND", "PROCESSED", { ref: bet.ext, refId: bet.id });
    await rejects(insertTx(walletId, "ROLLBACK", "PROCESSED", { ref: bet.ext, refId: bet.id }), /ux_reversal_once/);
    // reversões rejeitadas não contam
    await insertTx(walletId, "ROLLBACK", "REJECTED", { ref: bet.ext, refId: bet.id });
  });

  test("valor zero só em LOSS; REFUND/ROLLBACK exigem referência", async () => {
    const walletId = await insertWallet();
    await rejects(insertTx(walletId, "BET", "PROCESSED", { amount: "0" }), /check constraint/i);
    await insertTx(walletId, "LOSS", "PROCESSED", { amount: "0" });
    await rejects(insertTx(walletId, "REFUND", "PROCESSED"), /ck_wager_reversal_requires_reference/);
  });
});

describe("migrations", () => {
  const scratchDb = `wagering_migration_${Date.now()}`;
  const admin = db;
  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`);
  });

  test("up → down → up em um banco limpo (reversíveis)", async () => {
    await admin.unsafe(`CREATE DATABASE ${scratchDb}`);
    const url = DATABASE_URL.replace(/\/[^/]+$/, `/${scratchDb}`);
    const orm = await createOrm(url, 2);
    const probe = new SQL(url);
    try {
      const migrator = orm.getMigrator();
      await migrator.up();
      const tables = async () =>
        (await probe`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations' ORDER BY 1`).map(
          (r: { tablename: string }) => r.tablename,
        );
      expect(await tables()).toEqual(["inbox_message", "outbox_message", "wager_transaction", "wallet", "wallet_ledger_entry"]);
      await migrator.down();
      expect(await tables()).toEqual([]);
      await migrator.up();
      expect(await tables()).toHaveLength(5);
    } finally {
      await probe.close();
      await orm.close(true);
    }
  });
});
