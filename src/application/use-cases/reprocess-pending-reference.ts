import { WagerTransactionStatus } from "../../domain/wagering/enums";
import { applyWageringPolicy } from "../../domain/wagering/wagering-policy";
import type { Clock, IdGenerator, Metrics, UnitOfWork } from "../ports";
import { DecisionRecorder, type PendingSchedule } from "./decision-recorder";

/**
 * Reprocessa uma transação PENDING_REFERENCE. Ordem de locks igual à do caminho principal
 * (wallet → transação) para não criar deadlock com quem está processando a referência.
 */
export class ReprocessPendingReference {
  private readonly recorder: DecisionRecorder;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    metrics: Metrics,
    pending: PendingSchedule,
  ) {
    this.recorder = new DecisionRecorder(clock, ids, metrics, pending);
  }

  async execute(transactionId: string): Promise<WagerTransactionStatus | undefined> {
    return this.uow.run(async (scope) => {
      // leitura sem lock só para descobrir a wallet; depois wallet → transação, como no caminho principal
      const peek = await scope.findTransactionById(transactionId);
      if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return peek?.status;
      const wallet = await scope.lockWallet(peek.walletId);
      const tx = await scope.lockTransaction(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return tx?.status;
      const reference = tx.referenceExternalTransactionId
        ? await scope.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId)
        : null;
      const referenceAlreadyReversed = reference ? await scope.hasProcessedReversal(reference.id) : false;
      const decision = applyWageringPolicy({
        transaction: tx,
        wallet,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        now: this.clock.now(),
      });
      await this.recorder.record(scope, {
        tx,
        wallet,
        decision,
        isNew: false,
        correlationId: tx.id,
        causationId: tx.id,
      });
      return tx.status;
    });
  }
}
