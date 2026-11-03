import { CurrencyMismatchError, InvalidMoneyError } from "../shared/errors";

/** DTO de contrato: valor sempre como string decimal. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 100n;

/**
 * Value object monetário. Guarda centavos em `bigint` (exato, sem ponto flutuante)
 * e trabalha com escala fixa de 2 casas. Imutável: toda operação devolve nova instância.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Valida o formato de entrada. Aceita "25", "25.5", "25.50"; rejeita negativo, NaN, 1e3, >2 casas. */
  static from(props: MoneyProps): Money {
    const amount = props?.amount;
    const currency = props?.currency;
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid amount: ${JSON.stringify(amount)}`);
    }
    Money.assertCurrency(currency);
    const [whole = "0", fraction = ""] = amount.split(".");
    const minor = BigInt(whole) * SCALE + BigInt(fraction.padEnd(2, "0"));
    return new Money(minor, currency);
  }

  /** Reconstrói a partir de um valor já persistido (pode ser negativo apenas em cálculos internos). */
  static fromDecimalString(value: string, currency: string): Money {
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole = "0", fraction = ""] = unsigned.split(".");
    if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) {
      throw new InvalidMoneyError(`Invalid persisted amount: ${value}`);
    }
    Money.assertCurrency(currency);
    const minor = BigInt(whole) * SCALE + BigInt(fraction.padEnd(2, "0"));
    return new Money(negative ? -minor : minor, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** Valor decimal com 2 casas, ex.: "25.00", "-3.50". */
  toAmountString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const whole = abs / SCALE;
    const fraction = (abs % SCALE).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toAmountString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toAmountString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: ${JSON.stringify(currency)}`);
    }
  }
}
