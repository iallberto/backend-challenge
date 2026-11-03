import type { MoneyProps } from "../domain/money/money";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  lastBalanceAfter: string | null;
  checkedEntries: number;
}

/** Leituras que não alteram estado. */
export interface WalletReadModel {
  getWallet(id: string): Promise<Wallet | null>;
  getLedgerPage(walletId: string, afterSeq: bigint | null, limit: number): Promise<{ items: WalletLedgerEntry[]; lastSeq: bigint | null; hasMore: boolean }>;
  getTransaction(id: string): Promise<WagerTransaction | null>;
  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Foto consistente (REPEATABLE READ) do saldo guardado e do saldo recalculado pelo ledger. */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Cursor opaco: base64url do último `seq` entregue. */
export const ledgerCursor = {
  encode(seq: bigint): string {
    return Buffer.from(`seq:${seq}`).toString("base64url");
  },
  decode(cursor: string): bigint | null {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^seq:(\d{1,19})$/.exec(decoded);
    return match ? BigInt(match[1]!) : null;
  },
};
