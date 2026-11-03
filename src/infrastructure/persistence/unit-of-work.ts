import {
  ConnectionException,
  DeadlockException,
  DriverException,
  LockMode,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
  type MikroORM,
} from "@mikro-orm/core";
import type { EntityManager, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { TransientError, UniqueViolationError } from "../../application/errors";
import type { Metrics, TransactionScope, UnitOfWork } from "../../application/ports";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wagering/enums";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { inboxMapper, ledgerMapper, outboxMapper, transactionMapper, walletMapper } from "./mappers";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas";

/** SQLSTATEs do Postgres tratados como transitórios: conexão, desligamento, serialização, deadlock, lock timeout. */
const TRANSIENT_SQLSTATE = /^(08|57P0|40001|40P01|55P03|53)/;

/** Traduz exceções do driver em erros da aplicação. */
export function translateDbError(error: unknown, metrics?: Metrics): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = (error as unknown as { constraint?: string }).constraint;
    return new UniqueViolationError(constraint);
  }
  if (error instanceof LockWaitTimeoutException) {
    metrics?.lockConflict();
    return new TransientError("Lock wait timeout", error);
  }
  if (error instanceof ConnectionException || error instanceof DeadlockException) {
    return new TransientError(error.message, error);
  }
  if (error instanceof DriverException) {
    const code = (error as unknown as { code?: string }).code ?? "";
    if (code === "55P03") metrics?.lockConflict();
    if (TRANSIENT_SQLSTATE.test(code)) return new TransientError(error.message, error);
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "57P01") {
    return new TransientError(String((error as Error).message), error);
  }
  if (error instanceof Error && /timeout acquiring a connection|Connection terminated|connect ECONNREFUSED/i.test(error.message)) {
    return new TransientError(error.message, error);
  }
  return error;
}

class MikroOrmScope implements TransactionScope {
  constructor(private readonly em: EntityManager) {}

  async lockWallet(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletMapper.toDomain(record) : null;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    this.em.persist(this.em.create(WalletRecord, walletMapper.toRecord(wallet)));
    await this.em.flush();
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const record = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    this.em.assign(record, walletMapper.toRecord(wallet));
  }

  async findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { idempotencyKey: key });
    return r ? transactionMapper.toDomain(r) : null;
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return r ? transactionMapper.toDomain(r) : null;
  }

  async findTransactionById(id: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { id });
    return r ? transactionMapper.toDomain(r) : null;
  }

  async lockTransaction(id: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? transactionMapper.toDomain(r) : null;
  }

  async insertTransaction(tx: WagerTransaction): Promise<void> {
    this.em.persist(this.em.create(WagerTransactionRecord, transactionMapper.toRecord(tx)));
  }

  async saveTransaction(tx: WagerTransaction): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, { id: tx.id });
    this.em.assign(record, transactionMapper.toRecord(tx));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async wakePendingFor(providerId: string, externalTransactionId: string, at: Date): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
      },
      { nextAttemptAt: at },
    );
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(this.em.create(LedgerEntryRecord, ledgerMapper.toRecord(entry)));
  }

  async inboxExists(consumerName: string, messageId: string): Promise<boolean> {
    return (await this.em.count(InboxMessageRecord, { consumerName, messageId })) > 0;
  }

  async insertInbox(message: InboxMessage): Promise<void> {
    this.em.persist(this.em.create(InboxMessageRecord, inboxMapper.toRecord(message)));
  }

  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    this.em.persist(this.em.create(OutboxMessageRecord, outboxMapper.toRecord(OutboxMessage.enqueue(event))));
  }

  async claimDueOutbox(limit: number, now: Date): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { occurredAt: "asc" }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map((r) => outboxMapper.toDomain(r));
  }

  async saveOutbox(message: OutboxMessage): Promise<void> {
    const record = await this.em.findOneOrFail(OutboxMessageRecord, { id: message.id });
    this.em.assign(record, outboxMapper.toRecord(message));
  }

  async claimDuePending(limit: number, now: Date, leaseUntil: Date): Promise<string[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: "asc" }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    for (const r of records) r.nextAttemptAt = leaseUntil;
    return records.map((r) => r.id);
  }
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM<PostgreSqlDriver>,
    private readonly defaultLockTimeoutMs: number,
    private readonly metrics?: Metrics,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options?: { lockTimeoutMs?: number }): Promise<T> {
    const em = this.orm.em.fork() as EntityManager;
    const lockTimeout = Math.max(1, Math.trunc(options?.lockTimeoutMs ?? this.defaultLockTimeoutMs));
    try {
      return await em.transactional(async (txEm) => {
        await txEm.execute(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
        return work(new MikroOrmScope(txEm as EntityManager));
      });
    } catch (error) {
      throw translateDbError(error, this.metrics);
    }
  }
}
