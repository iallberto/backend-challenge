import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/wagering-events";
import { backoffDelayMs } from "../../domain/messaging/outbox-message";
import { FailureCode } from "../../domain/wagering/failure-code";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { PolicyDecision } from "../../domain/wagering/wagering-policy";
import type { Wallet } from "../../domain/wallet/wallet";
import type { Clock, IdGenerator, Metrics, TransactionScope } from "../ports";

export interface PendingSchedule {
  backoffBaseMs: number;
  backoffMaxMs: number;
  ttlMs: number;
}

export interface RecordInput {
  tx: WagerTransaction;
  wallet: Wallet | null;
  decision: PolicyDecision;
  /** true = transação nova (insert); false = reprocessamento de pendente (update). */
  isNew: boolean;
  correlationId: string;
  causationId?: string;
}

/** Persiste o resultado de uma decisão e enfileira os eventos correspondentes na outbox. */
export class DecisionRecorder {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly pending: PendingSchedule,
  ) {}

  async record(scope: TransactionScope, input: RecordInput): Promise<void> {
    const { tx, wallet, decision } = input;
    const now = this.clock.now();
    const ctx = () => ({
      eventId: this.ids.next(),
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: now,
    });

    if (decision.outcome === "awaiting_reference") {
      if (input.isNew) {
        tx.markPendingReference(
          new Date(now.getTime() + this.backoff(0)),
          new Date(now.getTime() + this.pending.ttlMs),
          wallet!.balance,
          wallet!.version,
          now,
        );
        await scope.enqueue(WagerTransactionPendingReference.from(tx, ctx()));
      } else if (tx.expiresAt && now.getTime() >= tx.expiresAt.getTime()) {
        tx.reject(FailureCode.ReferenceNotFound, now, wallet?.balance, wallet?.version);
        await scope.enqueue(WagerTransactionRejected.from(tx, ctx()));
      } else {
        tx.rescheduleReferenceCheck(new Date(now.getTime() + this.backoff(tx.attempts + 1)), now);
        this.metrics.retry("pending_reference");
      }
    } else if (decision.outcome === "processed") {
      if (decision.entry && wallet) {
        await scope.insertLedgerEntry(decision.entry);
        await scope.saveWallet(wallet);
      }
      // a transação precisa existir antes dos eventos e do lançamento (FKs checadas no commit)
      await this.persist(scope, input);
      if (decision.entry && wallet) await scope.enqueue(WalletBalanceChanged.from(wallet, decision.entry, ctx()));
      await scope.enqueue(WagerTransactionProcessed.from(tx, ctx()));
      await scope.wakePendingFor(tx.providerId, tx.externalTransactionId, now);
      this.metrics.transaction(tx.status, tx.kind);
      return;
    } else {
      await scope.enqueue(WagerTransactionRejected.from(tx, ctx()));
      // quem aguardava esta transação como referência pode ser decidido já (REFERENCE_NOT_PROCESSED)
      await scope.wakePendingFor(tx.providerId, tx.externalTransactionId, now);
    }

    await this.persist(scope, input);
    this.metrics.transaction(tx.status, tx.kind);
  }

  private async persist(scope: TransactionScope, input: RecordInput): Promise<void> {
    if (input.isNew) await scope.insertTransaction(input.tx);
    else await scope.saveTransaction(input.tx);
  }

  private backoff(attempts: number): number {
    return backoffDelayMs(attempts, {
      baseMs: this.pending.backoffBaseMs,
      maxMs: this.pending.backoffMaxMs,
      jitter: 0.2,
    });
  }
}
