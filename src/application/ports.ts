import type { IntegrationEvent } from "../domain/events/integration-event";
import type { InboxMessage } from "../domain/messaging/inbox-message";
import type { OutboxMessage } from "../domain/messaging/outbox-message";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";

/** Operações disponíveis dentro de uma transação SQL. Tudo que é feito aqui é atômico. */
export interface TransactionScope {
  /** Trava a linha da wallet (SELECT … FOR UPDATE) até o fim da transação. */
  lockWallet(id: string): Promise<Wallet | null>;
  insertWallet(wallet: Wallet): Promise<void>;
  saveWallet(wallet: Wallet): Promise<void>;

  findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findTransactionById(id: string): Promise<WagerTransaction | null>;
  /** Trava a transação para reprocessamento (pendentes). */
  lockTransaction(id: string): Promise<WagerTransaction | null>;
  insertTransaction(tx: WagerTransaction): Promise<void>;
  saveTransaction(tx: WagerTransaction): Promise<void>;
  /** Existe reversão (REFUND/ROLLBACK) PROCESSED apontando para a referência? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Antecipa a próxima tentativa das operações que aguardam esta referência. */
  wakePendingFor(providerId: string, externalTransactionId: string, at: Date): Promise<void>;

  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;

  inboxExists(consumerName: string, messageId: string): Promise<boolean>;
  insertInbox(message: InboxMessage): Promise<void>;

  enqueue(event: IntegrationEvent<unknown>): Promise<void>;

  /** Lote da outbox pronto para publicar, travado com SKIP LOCKED. */
  claimDueOutbox(limit: number, now: Date): Promise<OutboxMessage[]>;
  saveOutbox(message: OutboxMessage): Promise<void>;

  /** Ids de pendentes vencidos, travados com SKIP LOCKED e "alugados" até leaseUntil. */
  claimDuePending(limit: number, now: Date, leaseUntil: Date): Promise<string[]>;
}

export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: { lockTimeoutMs?: number }): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

/** Porta de identidade do chamador (decisão Q1). Hoje: header de desenvolvimento; amanhã: JWT. */
export interface ProviderIdentity {
  providerId: string;
}

export interface FaultInjector {
  /** Mata o processo (ou lança erro) quando o ponto informado está ativo. No-op fora de teste. */
  at(point: FaultPoint): void;
}

export type FaultPoint =
  | "crash_after_commit_before_ack"
  | "crash_after_commit_before_publish"
  | "crash_after_publish_before_mark"
  | "permanent_error_in_use_case";

export interface Metrics {
  transaction(status: string, kind: string): void;
  duplicate(channel: "http" | "sqs"): void;
  retry(component: string): void;
  lockConflict(): void;
  observeProcessing(seconds: number): void;
  reconciliationDivergence(): void;
}

export interface Logger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}
