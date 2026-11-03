import { Money } from "../money/money";
import { CurrencyMismatchError, InsufficientFundsError } from "../shared/errors";
import { LedgerDirection } from "../wagering/enums";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. É o único ponto que altera o saldo, e cada alteração devolve o
 * lançamento correspondente: saldo e ledger não têm como divergir.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Cria a wallet com versão 1. Saldo inicial > 0 gera o lançamento de crédito da transação
   * interna OPENING; ele faz parte da criação, então a versão continua 1.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 1, props.at, props.at);
    if (props.initialBalance.isNegative()) {
      throw new InsufficientFundsError();
    }
    if (!props.initialBalance.isPositive()) {
      return { wallet };
    }
    const openingEntry = wallet.apply(
      LedgerDirection.Credit,
      props.initialBalance,
      props.openingTransactionId,
      props.openingEntryId,
      props.at,
      false,
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, entryId, at);
  }

  credit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, entryId, at);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    entryId: string,
    at: Date,
    bumpVersion = true,
  ): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    // a versão só muda quando o saldo muda (a abertura conta como criação: versão 1)
    this._balance = after;
    if (bumpVersion) this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
