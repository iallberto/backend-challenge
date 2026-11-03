import { InsufficientFundsError } from "../shared/errors";
import { Wallet } from "../wallet/wallet";
import { WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from "./enums";
import { FailureCode } from "./failure-code";
import { WagerTransaction } from "./wager-transaction";

/** Tipos de referência aceitos por kind (README §7 + decisões Q3 e FR-050). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
};

export interface PolicyInput {
  transaction: WagerTransaction;
  /** null quando a wallet informada não existe. */
  wallet: Wallet | null;
  /** null quando a referência ainda não chegou (ou não foi informada). */
  reference: WagerTransaction | null;
  /** true se a referência já recebeu uma reversão PROCESSED (REFUND ou ROLLBACK). */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
}

export type PolicyDecision =
  | { outcome: "processed"; entry?: WalletLedgerEntry }
  | { outcome: "rejected"; code: FailureCode }
  | { outcome: "awaiting_reference" };

/**
 * Regras de BET, WIN, LOSS, REFUND e ROLLBACK. Aplica a transição na transação e, quando
 * há efeito no saldo, o débito/crédito na wallet. Não persiste nada: só decide e muta em memória.
 */
export function applyWageringPolicy(input: PolicyInput): PolicyDecision {
  const { transaction: tx, wallet, reference, now } = input;

  const reject = (code: FailureCode): PolicyDecision => {
    tx.reject(code, now, wallet?.balance, wallet?.version);
    return { outcome: "rejected", code };
  };

  if (!wallet) return reject(FailureCode.WalletNotFound);
  if (wallet.playerId !== tx.playerId) return reject(FailureCode.WalletPlayerMismatch);
  if (wallet.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);

  if (tx.hasReference()) {
    if (!reference || reference.status === WagerTransactionStatus.PendingReference) {
      // a referência ainda pode chegar ou mudar de estado: aguardar
      return { outcome: "awaiting_reference" };
    }
    const allowed = ALLOWED_REFERENCE_KINDS[tx.kind];
    if (!allowed || !allowed.has(reference.kind)) return reject(FailureCode.InvalidReferenceKind);
    if (
      reference.walletId !== tx.walletId ||
      reference.playerId !== tx.playerId ||
      reference.roundId !== tx.roundId ||
      reference.money.currency !== tx.money.currency
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (reference.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);
    if (input.referenceAlreadyReversed) {
      return reject(tx.isReversal() ? FailureCode.ReferenceAlreadyReversed : FailureCode.ReferenceReversed);
    }
    if (tx.isReversal() && !tx.money.equals(reference.money)) return reject(FailureCode.ReversalAmountMismatch);
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, wallet.balance, wallet.version);
    return { outcome: "processed" };
  }

  const direction = tx.ledgerDirectionFor(reference ?? undefined);
  let entry: WalletLedgerEntry;
  try {
    entry =
      direction === LedgerDirection.Debit
        ? wallet.debit(tx.money, tx.id, input.ledgerEntryId, now)
        : wallet.credit(tx.money, tx.id, input.ledgerEntryId, now);
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      // reversão sem saldo é operacionalmente diferente de aposta sem saldo
      return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
    }
    throw error;
  }
  tx.markProcessed(reference?.id, now, wallet.balance, wallet.version);
  return { outcome: "processed", entry };
}
