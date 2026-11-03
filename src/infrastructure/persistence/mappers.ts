import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from "../../domain/wagering/enums";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas";

/*
 * Único lugar onde Money vira NUMERIC (string) e vice-versa.
 * Leitura sempre por `rehydrate`: o estado persistido não é revalidado.
 */

export const walletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: Money.fromDecimalString(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.toAmountString(),
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const transactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: Money.fromDecimalString(r.amount, r.currency),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode: (r.failureCode as FailureCode | null) ?? undefined,
      processedAt: r.processedAt ?? undefined,
      resultBalance: r.resultBalance ? Money.fromDecimalString(r.resultBalance, r.currency) : undefined,
      resultWalletVersion: r.resultWalletVersion ?? undefined,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt ?? undefined,
      expiresAt: r.expiresAt ?? undefined,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.toAmountString(),
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      resultBalance: t.resultBalance?.toAmountString() ?? null,
      resultWalletVersion: t.resultWalletVersion ?? null,
      attempts: t.attempts,
      nextAttemptAt: t.nextAttemptAt ?? null,
      expiresAt: t.expiresAt ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      processedAt: t.processedAt ?? null,
    };
  },
};

export const ledgerMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: Money.fromDecimalString(r.amount, r.currency),
      balanceBefore: Money.fromDecimalString(r.balanceBefore, r.currency),
      balanceAfter: Money.fromDecimalString(r.balanceAfter, r.currency),
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.toAmountString(),
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.toAmountString(),
      balanceAfter: e.balanceAfter.toAmountString(),
      createdAt: e.createdAt,
    };
  },
};

export const inboxMapper = {
  toRecord(m: InboxMessage): InboxMessageRecord {
    return {
      consumerName: m.consumerName,
      messageId: m.messageId,
      payloadHash: m.payloadHash,
      receivedAt: m.receivedAt,
      processedAt: m.processedAt ?? null,
    };
  },
};

export const outboxMapper = {
  toDomain(r: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      eventVersion: r.eventVersion,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      publishedAt: r.publishedAt ?? undefined,
      lastError: r.lastError ?? undefined,
    });
  },
  toRecord(m: OutboxMessage): OutboxMessageRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      eventVersion: m.eventVersion,
      payload: m.payload as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt,
      publishedAt: m.publishedAt ?? null,
      lastError: m.lastError ?? null,
    };
  },
};
