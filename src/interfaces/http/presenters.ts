import { WagerTransactionStatus } from "../../domain/wagering/enums";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

/** Status HTTP de um resultado persistido (contracts/failure-codes.md). O replay repete o original. */
export function httpStatusFor(tx: WagerTransaction): number {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      return 500;
  }
}

export function presentSubmitResult(tx: WagerTransaction, replay: boolean) {
  return {
    transactionId: tx.id,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: tx.resultBalance?.toJSON() ?? null,
    idempotentReplay: replay,
  };
}

export function presentWallet(w: Wallet, detailed = false) {
  return {
    id: w.id,
    playerId: w.playerId,
    balance: w.balance.toJSON(),
    version: w.version,
    ...(detailed ? { createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString() } : {}),
  };
}

export function presentTransaction(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export function presentLedgerEntry(e: WalletLedgerEntry) {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    createdAt: e.createdAt.toISOString(),
  };
}
