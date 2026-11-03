import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { InvalidTransactionStateError } from "../../../src/domain/shared/errors";
import { LedgerDirection, WagerTransactionKind as K, WagerTransactionStatus as S } from "../../../src/domain/wagering/enums";
import { FailureCode as F } from "../../../src/domain/wagering/failure-code";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { applyWageringPolicy } from "../../../src/domain/wagering/wagering-policy";
import { Wallet } from "../../../src/domain/wallet/wallet";

const now = new Date("2026-11-02T12:00:00Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
let seq = 0;

function wallet(balance: string): Wallet {
  return Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(balance), openingTransactionId: "o", openingEntryId: "e0", at: now }).wallet;
}

function tx(kind: K, amount: string, ref?: string, overrides: Partial<{ roundId: string; currency: string }> = {}) {
  seq += 1;
  return WagerTransaction.create({
    id: `t${seq}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: "h",
    walletId: "w1",
    playerId: "p1",
    roundId: overrides.roundId ?? "r1",
    gameId: "g1",
    kind,
    money: Money.from({ amount, currency: overrides.currency ?? "BRL" }),
    referenceExternalTransactionId: ref,
    createdAt: now,
  });
}

function run(t: WagerTransaction, w: Wallet | null, reference: WagerTransaction | null = null, reversed = false) {
  return applyWageringPolicy({
    transaction: t,
    wallet: w,
    reference,
    referenceAlreadyReversed: reversed,
    ledgerEntryId: `e-${t.id}`,
    now,
  });
}

function processed(kind: K, amount: string, w: Wallet, ref?: WagerTransaction) {
  const t = tx(kind, amount, ref?.externalTransactionId);
  run(t, w, ref ?? null);
  expect(t.status).toBe(S.Processed);
  return t;
}

describe("BET", () => {
  test("debita e gera um lançamento DEBIT", () => {
    const w = wallet("100.00");
    const t = tx(K.Bet, "25.00");
    const d = run(t, w);
    expect(d.outcome).toBe("processed");
    expect(d.outcome === "processed" && d.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toAmountString()).toBe("75.00");
    expect(t.resultBalance?.toAmountString()).toBe("75.00");
  });

  test("rejeita saldo insuficiente sem alterar saldo nem versão", () => {
    const w = wallet("10.00");
    const version = w.version;
    const t = tx(K.Bet, "25.00");
    expect(run(t, w)).toEqual({ outcome: "rejected", code: F.InsufficientFunds });
    expect(t.status).toBe(S.Rejected);
    expect(w.balance.toAmountString()).toBe("10.00");
    expect(w.version).toBe(version);
  });

  test("rejeita wallet inexistente, de outro jogador e moeda diferente", () => {
    expect(run(tx(K.Bet, "1.00"), null)).toEqual({ outcome: "rejected", code: F.WalletNotFound });
    const other = Wallet.open({ id: "w1", playerId: "p2", initialBalance: brl("0"), openingTransactionId: "o", openingEntryId: "e", at: now }).wallet;
    expect(run(tx(K.Bet, "1.00"), other)).toEqual({ outcome: "rejected", code: F.WalletPlayerMismatch });
    expect(run(tx(K.Bet, "1.00", undefined, { currency: "USD" }), wallet("10.00"))).toEqual({
      outcome: "rejected",
      code: F.CurrencyMismatch,
    });
  });
});

describe("WIN e LOSS", () => {
  test("WIN sem referência credita (free spin)", () => {
    const w = wallet("0.00");
    processed(K.Win, "50.00", w);
    expect(w.balance.toAmountString()).toBe("50.00");
  });

  test("LOSS não move saldo nem gera lançamento, mas é processado", () => {
    const w = wallet("100.00");
    const version = w.version;
    const t = tx(K.Loss, "0.00");
    expect(run(t, w)).toEqual({ outcome: "processed" });
    expect(t.status).toBe(S.Processed);
    expect(w.version).toBe(version);
  });

  test("WIN referenciando BET de outra rodada é rejeitado", () => {
    const w = wallet("100.00");
    const bet = processed(K.Bet, "10.00", w);
    const win = tx(K.Win, "20.00", bet.externalTransactionId, { roundId: "outra" });
    expect(run(win, w, bet)).toEqual({ outcome: "rejected", code: F.ReferenceMismatch });
  });

  test("WIN referenciando BET revertida é rejeitado com REFERENCE_REVERSED", () => {
    const w = wallet("100.00");
    const bet = processed(K.Bet, "10.00", w);
    const win = tx(K.Win, "20.00", bet.externalTransactionId);
    expect(run(win, w, bet, true)).toEqual({ outcome: "rejected", code: F.ReferenceReversed });
  });

  test("WIN referenciando BET que ainda não chegou fica aguardando", () => {
    expect(run(tx(K.Win, "20.00", "ainda-nao-existe"), wallet("1.00"), null)).toEqual({ outcome: "awaiting_reference" });
  });
});

describe("REFUND e ROLLBACK", () => {
  test("REFUND exige referência", () => {
    expect(() => tx(K.Refund, "10.00")).toThrow();
  });

  test("REFUND de BET credita o valor", () => {
    const w = wallet("100.00");
    const bet = processed(K.Bet, "25.00", w);
    processed(K.Refund, "25.00", w, bet);
    expect(w.balance.toAmountString()).toBe("100.00");
  });

  test("REFUND só referencia BET", () => {
    const w = wallet("100.00");
    const win = processed(K.Win, "10.00", w);
    expect(run(tx(K.Refund, "10.00", win.externalTransactionId), w, win)).toEqual({
      outcome: "rejected",
      code: F.InvalidReferenceKind,
    });
  });

  test("reversão com valor diferente é rejeitada", () => {
    const w = wallet("100.00");
    const bet = processed(K.Bet, "25.00", w);
    expect(run(tx(K.Refund, "20.00", bet.externalTransactionId), w, bet)).toEqual({
      outcome: "rejected",
      code: F.ReversalAmountMismatch,
    });
  });

  test("segunda reversão da mesma referência é rejeitada, de qualquer tipo (FR-049)", () => {
    const w = wallet("100.00");
    const bet = processed(K.Bet, "25.00", w);
    expect(run(tx(K.Rollback, "25.00", bet.externalTransactionId), w, bet, true)).toEqual({
      outcome: "rejected",
      code: F.ReferenceAlreadyReversed,
    });
  });

  test("ROLLBACK aplica o inverso: de BET credita, de WIN e de REFUND debita", () => {
    const w = wallet("100.00");
    const bet = processed(K.Bet, "25.00", w);
    processed(K.Rollback, "25.00", w, bet);
    expect(w.balance.toAmountString()).toBe("100.00");

    const win = processed(K.Win, "40.00", w);
    processed(K.Rollback, "40.00", w, win);
    expect(w.balance.toAmountString()).toBe("100.00");

    const bet2 = processed(K.Bet, "10.00", w);
    const refund = processed(K.Refund, "10.00", w, bet2);
    processed(K.Rollback, "10.00", w, refund);
    expect(w.balance.toAmountString()).toBe("90.00");
  });

  test("ROLLBACK de WIN sem saldo é rejeitado com código distinto do de aposta", () => {
    const w = wallet("0.00");
    const win = processed(K.Win, "50.00", w);
    processed(K.Bet, "40.00", w);
    expect(run(tx(K.Rollback, "50.00", win.externalTransactionId), w, win)).toEqual({
      outcome: "rejected",
      code: F.ReversalInsufficientFunds,
    });
    expect(w.balance.toAmountString()).toBe("10.00");
  });

  test("referência rejeitada leva a REFERENCE_NOT_PROCESSED imediato", () => {
    const w = wallet("1.00");
    const bet = tx(K.Bet, "25.00");
    run(bet, w);
    expect(bet.status).toBe(S.Rejected);
    expect(run(tx(K.Refund, "25.00", bet.externalTransactionId), w, bet)).toEqual({
      outcome: "rejected",
      code: F.ReferenceNotProcessed,
    });
  });
});

describe("estados terminais", () => {
  test("transicionar a partir de terminal é erro de programação", () => {
    const t = processed(K.Bet, "1.00", wallet("10.00"));
    expect(() => t.reject(F.InsufficientFunds, now)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(F.InternalError, now)).toThrow(InvalidTransactionStateError);
  });

  test("affectsBalance e requiresReference por kind", () => {
    expect(tx(K.Loss, "0.00").affectsBalance()).toBe(false);
    expect(tx(K.Bet, "1.00").affectsBalance()).toBe(true);
    expect(tx(K.Rollback, "1.00", "x").requiresReference()).toBe(true);
    expect(tx(K.Win, "1.00").requiresReference()).toBe(false);
  });
});
