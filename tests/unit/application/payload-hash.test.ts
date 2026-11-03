import { describe, expect, test } from "bun:test";
import { canonicalBusinessJson, payloadHash } from "../../../src/application/idempotency/payload-hash";
import { Money } from "../../../src/domain/money/money";
import { OutboxMessage, backoffDelayMs } from "../../../src/domain/messaging/outbox-message";

const base = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "p1",
  walletId: "w1",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: Money.from({ amount: "25.00", currency: "BRL" }),
};

describe("payloadHash", () => {
  test("JSON canônico tem chaves ordenadas e sem espaços", () => {
    const json = canonicalBusinessJson(base);
    expect(json.startsWith('{"amount":"25.00","currency":"BRL"')).toBe(true);
    expect(json).not.toContain(" ");
  });

  test("valor normalizado: '25' e '25.00' geram o mesmo hash", () => {
    const a = payloadHash(base);
    const b = payloadHash({ ...base, money: Money.from({ amount: "25", currency: "BRL" }) });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("qualquer campo de negócio diferente muda o hash", () => {
    expect(payloadHash({ ...base, money: Money.from({ amount: "26.00", currency: "BRL" }) })).not.toBe(payloadHash(base));
    expect(payloadHash({ ...base, roundId: "outra" })).not.toBe(payloadHash(base));
  });

  test("referência ausente e null geram o mesmo hash", () => {
    expect(payloadHash({ ...base, referenceExternalTransactionId: null })).toBe(payloadHash(base));
  });
});

describe("Outbox backoff", () => {
  test("cresce exponencialmente até o teto", () => {
    const policy = { baseMs: 1000, maxMs: 60_000, jitter: 0, random: () => 0.5 };
    expect([0, 1, 2, 3, 10].map((a) => backoffDelayMs(a, policy))).toEqual([1000, 2000, 4000, 8000, 60_000]);
  });

  test("jitter fica dentro de ±20 %", () => {
    const max = backoffDelayMs(2, { baseMs: 1000, maxMs: 60_000, jitter: 0.2, random: () => 1 });
    const min = backoffDelayMs(2, { baseMs: 1000, maxMs: 60_000, jitter: 0.2, random: () => 0 });
    expect(max).toBe(4800);
    expect(min).toBe(3200);
  });

  test("scheduleRetry incrementa attempts; markPublished encerra", () => {
    const msg = OutboxMessage.rehydrate({
      id: "e1",
      aggregateId: "a1",
      eventType: "X",
      eventVersion: 1,
      payload: {},
      occurredAt: new Date(0),
      attempts: 0,
      nextAttemptAt: new Date(0),
    });
    expect(msg.isDue(new Date(1))).toBe(true);
    msg.scheduleRetry(new Date(1000), "boom");
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(new Date(1000))).toBe(false);
    msg.markPublished(new Date(5000));
    expect(msg.isPending()).toBe(false);
  });
});
