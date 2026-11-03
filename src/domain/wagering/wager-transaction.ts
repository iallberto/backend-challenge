import { Money } from "../money/money";
import { DomainError, InvalidTransactionStateError } from "../shared/errors";
import { LedgerDirection, TERMINAL_STATUSES, WagerTransactionKind, WagerTransactionStatus } from "./enums";
import { FailureCode } from "./failure-code";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  resultWalletVersion?: number;
  attempts: number;
  nextAttemptAt?: Date;
  expiresAt?: Date;
  updatedAt: Date;
}

const KINDS_REQUIRING_REFERENCE = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

/**
 * Transições válidas:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (reagendamento)
 *   PROCESSED, REJECTED, FAILED são terminais.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _resultWalletVersion: number | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _expiresAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new DomainError(FailureCode.MissingReference, `${props.kind} requires referenceExternalTransactionId`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      props.createdAt,
    );
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.resultWalletVersion,
      s.attempts,
      s.nextAttemptAt,
      s.expiresAt,
      s.updatedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  /** Saldo observado quando a decisão foi tomada; devolvido no replay. */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get resultWalletVersion(): number | undefined {
    return this._resultWalletVersion;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get expiresAt(): Date | undefined {
    return this._expiresAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transições

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    resultBalance: Money,
    resultWalletVersion: number,
  ): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._resultWalletVersion = resultWalletVersion;
    this.clearSchedule(at);
  }

  markPendingReference(
    nextAttemptAt: Date,
    expiresAt: Date,
    observedBalance: Money,
    walletVersion: number,
    at: Date,
  ): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.PendingReference);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
    this._expiresAt = expiresAt;
    this._resultBalance = observedBalance;
    this._resultWalletVersion = walletVersion;
    this._updatedAt = at;
  }

  /** Nova tentativa agendada para uma transação que continua aguardando a referência. */
  rescheduleReferenceCheck(nextAttemptAt: Date, at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.PendingReference);
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money, walletVersion?: number): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    if (observedBalance) this._resultBalance = observedBalance;
    if (walletVersion !== undefined) this._resultWalletVersion = walletVersion;
    this.clearSchedule(at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this.clearSchedule(at);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. ROLLBACK aplica o inverso da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new Error("ROLLBACK requires the referenced transaction");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new Error("LOSS does not produce a ledger entry");
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }

  private clearSchedule(at: Date): void {
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }
}
