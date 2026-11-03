import { Money } from "../../domain/money/money";
import { NotFoundError } from "../errors";
import type { Logger, Metrics } from "../ports";
import type { ReconciliationReport, WalletReadModel } from "../queries";

/** Compara saldo guardado × saldo reconstruído pelo ledger. Divergência é sinalizada, nunca corrigida. */
export class ReconcileWallet {
  constructor(
    private readonly reads: WalletReadModel,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snap = await this.reads.reconciliationSnapshot(walletId);
    if (!snap) throw new NotFoundError("Wallet not found");
    const stored = Money.fromDecimalString(snap.storedBalance, snap.currency);
    const calculated = Money.fromDecimalString(snap.calculatedBalance, snap.currency);
    const difference = stored.subtract(calculated);
    const lastMatches =
      snap.lastBalanceAfter === null
        ? stored.isZero()
        : Money.fromDecimalString(snap.lastBalanceAfter, snap.currency).equals(stored);
    const consistent = difference.isZero() && lastMatches;

    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error(
        { walletId, checkedEntries: snap.checkedEntries, lastEntryMatches: lastMatches },
        "reconciliation divergence detected",
      );
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snap.checkedEntries,
    };
  }
}
