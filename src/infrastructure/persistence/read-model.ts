import { IsolationLevel, type MikroORM } from "@mikro-orm/core";
import type { EntityManager, PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { ReconciliationSnapshot, WalletReadModel } from "../../application/queries";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { translateDbError } from "./unit-of-work";
import { ledgerMapper, transactionMapper, walletMapper } from "./mappers";
import { type LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from "./schemas";

interface LedgerRow {
  id: string;
  seq: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

export class MikroOrmReadModel implements WalletReadModel {
  constructor(private readonly orm: MikroORM<PostgreSqlDriver>) {}

  private em(): EntityManager {
    return this.orm.em.fork() as EntityManager;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw translateDbError(error);
    }
  }

  getWallet(id: string): Promise<Wallet | null> {
    return this.guard(async () => {
      const r = await this.em().findOne(WalletRecord, { id });
      return r ? walletMapper.toDomain(r) : null;
    });
  }

  getLedgerPage(walletId: string, afterSeq: bigint | null, limit: number) {
    return this.guard(async () => {
      // keyset pagination por seq: estável mesmo com novos lançamentos durante a paginação
      const rows = await this.em().execute<LedgerRow[]>(
        `SELECT id, seq::text AS seq, wallet_id, transaction_id, direction, amount::text AS amount, currency,
                balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
           FROM wallet_ledger_entry
          WHERE wallet_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
        [walletId, (afterSeq ?? 0n).toString(), limit + 1],
      );
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const items: WalletLedgerEntry[] = page.map((r) =>
        ledgerMapper.toDomain({
          id: r.id,
          walletId: r.wallet_id,
          transactionId: r.transaction_id,
          direction: r.direction,
          amount: r.amount,
          currency: r.currency.trim(),
          balanceBefore: r.balance_before,
          balanceAfter: r.balance_after,
          createdAt: new Date(r.created_at),
        } satisfies LedgerEntryRecord),
      );
      const last = page.at(-1);
      return { items, lastSeq: last ? BigInt(last.seq) : null, hasMore };
    });
  }

  getTransaction(id: string): Promise<WagerTransaction | null> {
    return this.guard(async () => {
      const r = await this.em().findOne(WagerTransactionRecord, { id });
      return r ? transactionMapper.toDomain(r) : null;
    });
  }

  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.guard(async () => {
      const r = await this.em().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
      return r ? transactionMapper.toDomain(r) : null;
    });
  }

  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    return this.guard(() =>
      this.em().transactional(
        async (em) => {
          const rows = await em.execute<
            Array<{ currency: string; stored: string; calculated: string; last_after: string | null; checked: string }>
          >(
            `SELECT w.currency,
                    w.balance::text AS stored,
                    COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS calculated,
                    (SELECT balance_after::text FROM wallet_ledger_entry
                      WHERE wallet_id = w.id ORDER BY seq DESC LIMIT 1) AS last_after,
                    COUNT(l.id)::text AS checked
               FROM wallet w
               LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
              WHERE w.id = ?
              GROUP BY w.id, w.currency, w.balance`,
            [walletId],
          );
          const row = rows[0];
          if (!row) return null;
          return {
            walletId,
            currency: row.currency.trim(),
            storedBalance: row.stored,
            calculatedBalance: row.calculated,
            lastBalanceAfter: row.last_after,
            checkedEntries: Number(row.checked),
          };
        },
        { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
      ),
    );
  }
}
