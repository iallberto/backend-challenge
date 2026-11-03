import { createHash } from "node:crypto";
import { WagerTransactionFailed } from "../../domain/events/wagering-events";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { Money } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/errors";
import { WagerTransactionKind } from "../../domain/wagering/enums";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { applyWageringPolicy } from "../../domain/wagering/wagering-policy";
import {
  ApplicationError,
  AuthorizationError,
  ConflictError,
  TransientError,
  UniqueViolationError,
  ValidationError,
} from "../errors";
import { payloadHash } from "../idempotency/payload-hash";
import type {
  Clock,
  FaultInjector,
  IdGenerator,
  Logger,
  Metrics,
  ProviderIdentity,
  TransactionScope,
  UnitOfWork,
} from "../ports";
import type { WagerTransactionPayload } from "../validation";
import { DecisionRecorder, type PendingSchedule } from "./decision-recorder";

export interface SubmitWagerCommand extends WagerTransactionPayload {
  idempotencyKey: string;
  caller: ProviderIdentity;
  correlationId: string;
  channel: "http" | "sqs";
  /** Presente quando a entrada é SQS: deduplicação de transporte na mesma transação. */
  inbox?: { consumerName: string; messageId: string };
}

export type SubmitWagerResult =
  | { type: "result"; transaction: WagerTransaction; replay: boolean }
  | { type: "duplicate_message" };

const EXTERNAL_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

interface NormalizedInput {
  kind: WagerTransactionKind;
  money: Money;
  hash: string;
  reference?: string;
}

/**
 * Caso de uso único para HTTP e SQS. Em uma transação SQL:
 * trava a wallet → inbox → idempotência → regras → transação + ledger + saldo + outbox.
 */
export class SubmitWagerTransaction {
  private readonly recorder: DecisionRecorder;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly fault: FaultInjector,
    pending: PendingSchedule,
  ) {
    this.recorder = new DecisionRecorder(clock, ids, metrics, pending);
  }

  async execute(cmd: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const started = performance.now();
    const input = this.validate(cmd);

    // Autorização antes da idempotência e sem gravar nada: gravar a recusa permitiria a um
    // provedor "envenenar" a chave de outro (data-model §1.3).
    if (cmd.caller.providerId !== cmd.providerId) {
      throw new AuthorizationError(FailureCode.ProviderMismatch, "providerId does not match the caller identity");
    }

    try {
      const result = await this.uow.run((scope) => this.decide(scope, cmd, input));
      this.observe(result, cmd, started);
      if (result.type === "result" && !result.replay) this.fault.at("crash_after_commit_before_publish");
      return result;
    } catch (error) {
      if (error instanceof UniqueViolationError) return this.afterUniqueViolation(error, cmd, input);
      if (error instanceof ApplicationError || error instanceof TransientError) throw error;
      return this.recordPermanentFailure(cmd, input, error);
    }
  }

  private validate(cmd: SubmitWagerCommand): NormalizedInput {
    if (!cmd.idempotencyKey) {
      throw new ValidationError(FailureCode.MissingIdempotencyKey, "Idempotency-Key is required");
    }
    if (cmd.kind === WagerTransactionKind.Opening) {
      throw new ValidationError(FailureCode.OpeningNotAllowed, "OPENING is internal and cannot be submitted");
    }
    if (!EXTERNAL_KINDS.has(cmd.kind)) {
      throw new ValidationError(FailureCode.InvalidPayload, `Unknown kind ${cmd.kind}`);
    }
    const kind = cmd.kind as WagerTransactionKind;
    let money: Money;
    try {
      money = Money.from(cmd.money);
    } catch (error) {
      throw new ValidationError(FailureCode.InvalidMoney, (error as Error).message);
    }
    // FR-002a: valor > 0, exceto LOSS (>= 0). Mesma regra do CHECK do banco, validada antes.
    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw new ValidationError(FailureCode.InvalidMoney, "amount must be greater than zero");
    }
    const reference = cmd.referenceExternalTransactionId ?? undefined;
    if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
      throw new ValidationError(FailureCode.MissingReference, `${kind} requires referenceExternalTransactionId`);
    }
    const hash = payloadHash({ ...cmd, money, referenceExternalTransactionId: reference ?? null });
    return { kind, money, hash, reference };
  }

  private async decide(scope: TransactionScope, cmd: SubmitWagerCommand, input: NormalizedInput): Promise<SubmitWagerResult> {
    const now = this.clock.now();
    // 1. trava a linha da wallet: serializa as operações dessa wallet entre todas as instâncias
    const wallet = await scope.lockWallet(cmd.walletId);

    // 2. deduplicação de transporte (SQS)
    if (cmd.inbox) {
      if (await scope.inboxExists(cmd.inbox.consumerName, cmd.inbox.messageId)) {
        this.metrics.duplicate("sqs");
        return { type: "duplicate_message" };
      }
      await scope.insertInbox(
        InboxMessage.receive({ ...cmd.inbox, payloadHash: input.hash, receivedAt: now }),
      );
    }

    // 3. idempotência de negócio
    const existing = await scope.findTransactionByIdempotencyKey(cmd.idempotencyKey);
    if (existing) return this.replayOrConflict(existing, input.hash, cmd.channel);
    if (await scope.findTransactionByExternalId(cmd.providerId, cmd.externalTransactionId)) {
      throw new ConflictError(
        FailureCode.ExternalIdConflict,
        "externalTransactionId already exists with a different Idempotency-Key",
      );
    }

    // 4. regras
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: input.hash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.reference,
      createdAt: now,
    });
    const reference = input.reference ? await scope.findTransactionByExternalId(cmd.providerId, input.reference) : null;
    const referenceAlreadyReversed = reference ? await scope.hasProcessedReversal(reference.id) : false;

    this.fault.at("permanent_error_in_use_case");

    const decision = applyWageringPolicy({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      now,
    });

    // 5. grava transação, ledger, saldo e eventos (outbox) na mesma transação SQL
    await this.recorder.record(scope, {
      tx,
      wallet,
      decision,
      isNew: true,
      correlationId: cmd.correlationId,
      causationId: cmd.inbox?.messageId,
    });
    return { type: "result", transaction: tx, replay: false };
  }

  private replayOrConflict(existing: WagerTransaction, hash: string, channel: "http" | "sqs"): SubmitWagerResult {
    if (!existing.matchesPayload(hash)) {
      throw new ConflictError(FailureCode.IdempotencyKeyConflict, "Idempotency-Key reused with a different payload");
    }
    this.metrics.duplicate(channel);
    return { type: "result", transaction: existing, replay: true };
  }

  /** Outra instância venceu a corrida entre a verificação e o commit: relê e decide replay ou conflito. */
  private async afterUniqueViolation(
    error: UniqueViolationError,
    cmd: SubmitWagerCommand,
    input: NormalizedInput,
  ): Promise<SubmitWagerResult> {
    if (error.constraint === "pk_inbox_message") {
      this.metrics.duplicate("sqs");
      return { type: "duplicate_message" };
    }
    return this.uow.run(async (scope) => {
      const existing = await scope.findTransactionByIdempotencyKey(cmd.idempotencyKey);
      if (existing) return this.replayOrConflict(existing, input.hash, cmd.channel);
      if (await scope.findTransactionByExternalId(cmd.providerId, cmd.externalTransactionId)) {
        throw new ConflictError(FailureCode.ExternalIdConflict, "externalTransactionId already exists with a different Idempotency-Key");
      }
      if (error.constraint === "ux_reversal_once") {
        // duas reversões da mesma referência commitaram ao mesmo tempo; o índice parcial barrou a segunda
        throw new TransientError("Concurrent reversal detected; retry to receive the final result");
      }
      throw new TransientError(`Unexpected unique violation (${error.constraint ?? "unknown"})`);
    });
  }

  /**
   * Erro permanente não-negocial (FR-032a): grava FAILED + evento quando o banco está acessível.
   * Se nem isso for possível, propaga o erro (no SQS a mensagem segue para a DLQ).
   */
  private async recordPermanentFailure(cmd: SubmitWagerCommand, input: NormalizedInput, cause: unknown): Promise<SubmitWagerResult> {
    this.logger.error(
      { err: cause instanceof Error ? cause.message : String(cause), providerId: cmd.providerId, walletId: cmd.walletId },
      "permanent error while processing wager transaction",
    );
    if (cause instanceof DomainError) {
      throw new ValidationError(FailureCode.InvalidPayload, cause.message);
    }
    try {
      const result = await this.uow.run(async (scope) => {
        const existing = await scope.findTransactionByIdempotencyKey(cmd.idempotencyKey);
        if (existing) return this.replayOrConflict(existing, input.hash, cmd.channel);
        const now = this.clock.now();
        const tx = WagerTransaction.create({
          id: this.ids.next(),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash: input.hash,
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: input.kind,
          money: input.money,
          referenceExternalTransactionId: input.reference,
          createdAt: now,
        });
        tx.fail(FailureCode.InternalError, now);
        if (cmd.inbox && !(await scope.inboxExists(cmd.inbox.consumerName, cmd.inbox.messageId))) {
          await scope.insertInbox(InboxMessage.receive({ ...cmd.inbox, payloadHash: input.hash, receivedAt: now }));
        }
        await scope.insertTransaction(tx);
        await scope.enqueue(
          WagerTransactionFailed.from(tx, {
            eventId: this.ids.next(),
            correlationId: cmd.correlationId,
            causationId: cmd.inbox?.messageId,
            occurredAt: now,
          }),
        );
        this.metrics.transaction(tx.status, tx.kind);
        return { type: "result", transaction: tx, replay: false } as const;
      });
      return result;
    } catch {
      throw cause;
    }
  }

  private observe(result: SubmitWagerResult, cmd: SubmitWagerCommand, started: number): void {
    this.metrics.observeProcessing((performance.now() - started) / 1000);
    if (result.type === "result" && !result.replay) {
      this.logger.info(
        {
          transactionId: result.transaction.id,
          walletId: cmd.walletId,
          providerId: cmd.providerId,
          kind: result.transaction.kind,
          status: result.transaction.status,
          failureCode: result.transaction.failureCode,
        },
        "wager transaction decided",
      );
    }
  }
}

/** Hash estável para a transação interna de abertura. */
export function openingHash(walletId: string, money: Money): string {
  return createHash("sha256").update(`opening:${walletId}:${money.toString()}`).digest("hex");
}
