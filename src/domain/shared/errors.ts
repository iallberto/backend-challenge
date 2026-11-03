/** Base de todo erro de domínio: violação de regra que o chamador pode corrigir ou aceitar. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY", message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super("CURRENCY_MISMATCH", `Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super("INSUFFICIENT_FUNDS", "Insufficient funds");
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor() {
    super("UNBALANCED_LEDGER_ENTRY", "balanceBefore ± money must equal balanceAfter");
  }
}

/** Transição a partir de estado terminal: erro de programação, nunca caminho de negócio. */
export class InvalidTransactionStateError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid transaction transition: ${from} -> ${to}`);
    this.name = "InvalidTransactionStateError";
  }
}
