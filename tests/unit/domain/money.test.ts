import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/shared/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test.each([
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["25.50", "25.50"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["99999999999999999.99", "99999999999999999.99"],
  ])("aceita %p e normaliza para %p", (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test.each(["", "NaN", "Infinity", "-1", "-0.01", "1e3", "25.505", "25.", ".5", "025", " 25", "25,00", "123456789012345678"])(
    "rejeita %p",
    (input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    },
  );

  test("rejeita amount que não é string (number é proibido para dinheiro)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLL", ""])("rejeita moeda inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("soma e subtração são exatas (sem erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).toAmountString()).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.00")).toAmountString()).toBe("20.00");
    expect(brl("10.00").subtract(brl("10.01")).toAmountString()).toBe("-0.01");
  });

  test("é imutável: operações devolvem nova instância", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.toAmountString()).toBe("10.00");
    expect(b.toAmountString()).toBe("15.00");
    expect(a).not.toBe(b);
  });

  test("negate, comparações e predicados", () => {
    expect(brl("5.00").negate().toAmountString()).toBe("-5.00");
    expect(brl("5.00").negate().isNegative()).toBe(true);
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.00").equals(brl("1"))).toBe(true);
  });

  test("operações entre moedas diferentes lançam erro de domínio", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl("1.00").equals(usd)).toBe(false);
  });

  test("reidrata o formato persistido do NUMERIC", () => {
    expect(Money.fromDecimalString("975.00", "BRL").toString()).toBe("975.00 BRL");
    expect(Money.fromDecimalString("-3.5", "BRL").toAmountString()).toBe("-3.50");
  });
});
