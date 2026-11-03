import { WagerTransactionProcessed, WalletBalanceChanged } from "../../domain/events/wagering-events";
import { Money } from "../../domain/money/money";
import { WagerTransactionKind } from "../../domain/wagering/enums";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { ConflictError, UniqueViolationError, ValidationError } from "../errors";
import type { Clock, IdGenerator, Metrics, UnitOfWork } from "../ports";
import type { OpenWalletPayload } from "../validation";
import { openingHash } from "./submit-wager-transaction";

export const INTERNAL_PROVIDER = "internal";

/** Cria a wallet; saldo inicial > 0 gera a transação OPENING + crédito no ledger na mesma transação SQL. */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async execute(input: OpenWalletPayload & { correlationId: string }): Promise<Wallet> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(input.initialBalance);
    } catch (error) {
      throw new ValidationError(FailureCode.InvalidMoney, (error as Error).message);
    }

    try {
      return await this.uow.run(async (scope) => {
        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTxId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: input.playerId,
          initialBalance,
          openingTransactionId: openingTxId,
          openingEntryId: this.ids.next(),
          at: now,
        });
        // flush imediato: a duplicata (player + moeda) é barrada pelo UNIQUE do banco
        await scope.insertWallet(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.create({
            id: openingTxId,
            providerId: INTERNAL_PROVIDER,
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `${INTERNAL_PROVIDER}:opening:${walletId}`,
            payloadHash: openingHash(walletId, initialBalance),
            walletId,
            playerId: input.playerId,
            roundId: "opening",
            gameId: "internal",
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: now,
          });
          opening.markProcessed(undefined, now, wallet.balance, wallet.version);
          await scope.insertTransaction(opening);
          await scope.insertLedgerEntry(openingEntry);
          const ctx = () => ({ eventId: this.ids.next(), correlationId: input.correlationId, occurredAt: now });
          await scope.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx()));
          await scope.enqueue(WagerTransactionProcessed.from(opening, ctx()));
          this.metrics.transaction(opening.status, opening.kind);
        }
        return wallet;
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "ux_wallet_player_currency") {
        throw new ConflictError(FailureCode.WalletAlreadyExists, "Wallet already exists for this player and currency");
      }
      throw error;
    }
  }
}
