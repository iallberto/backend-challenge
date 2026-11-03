import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InsufficientFundsError, UnbalancedLedgerEntryError } from "../../../src/domain/shared/errors";
import { LedgerDirection } from "../../../src/domain/wagering/enums";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-11-02T12:00:00Z");
const open = (initial = "0.00") =>
  Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(initial), openingTransactionId: "o1", openingEntryId: "oe1", at: now }).wallet;

describe("Wallet", () => {
  test("abre com saldo zero e versão 1, sem lançamento", () => {
    const opened = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("0"), openingTransactionId: "o", openingEntryId: "e", at: now });
    expect(opened.wallet.balance.toAmountString()).toBe("0.00");
    expect(opened.wallet.version).toBe(1);
    expect(opened.openingEntry).toBeUndefined();
  });

  test("saldo inicial gera crédito de abertura e mantém versão 1", () => {
    const opened = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("1000.00"), openingTransactionId: "o", openingEntryId: "e", at: now });
    expect(opened.wallet.balance.toAmountString()).toBe("1000.00");
    expect(opened.wallet.version).toBe(1);
    expect(opened.openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(opened.openingEntry?.balanceAfter.toAmountString()).toBe("1000.00");
  });

  test("crédito gera lançamento coerente e incrementa a versão", () => {
    const w = open();
    const entry = w.credit(brl("100.00"), "t1", "e1", now);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toAmountString()).toBe("0.00");
    expect(entry.balanceAfter.toAmountString()).toBe("100.00");
    expect(entry.isBalanced()).toBe(true);
    expect(w.balance.toAmountString()).toBe("100.00");
    expect(w.version).toBe(2);
  });

  test("débito sem saldo lança erro e não altera saldo nem versão", () => {
    const w = open();
    w.credit(brl("10.00"), "t1", "e1", now);
    expect(() => w.debit(brl("25.00"), "t2", "e2", now)).toThrow(InsufficientFundsError);
    expect(w.balance.toAmountString()).toBe("10.00");
    expect(w.version).toBe(2);
  });

  test("débito exato zera o saldo sem ficar negativo", () => {
    const w = open();
    w.credit(brl("80.00"), "t1", "e1", now);
    w.debit(brl("80.00"), "t2", "e2", now);
    expect(w.balance.isZero()).toBe(true);
  });

  test("moeda diferente da wallet é rejeitada", () => {
    const w = open();
    expect(() => w.credit(Money.from({ amount: "1.00", currency: "USD" }), "t", "e", now)).toThrow(CurrencyMismatchError);
  });
});

describe("WalletLedgerEntry", () => {
  test("factory valida a aritmética do lançamento", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e",
        walletId: "w",
        transactionId: "t",
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("95.00"),
        createdAt: now,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("não tem setters: campos são somente leitura", () => {
    const entry = open().credit(brl("1.00"), "t", "e", now);
    expect(Object.getOwnPropertyDescriptor(WalletLedgerEntry.prototype, "money")).toBeUndefined();
    expect(entry.isBalanced()).toBe(true);
  });
});
