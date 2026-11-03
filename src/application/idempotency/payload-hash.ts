import { createHash } from "node:crypto";
import { Money } from "../../domain/money/money";

export interface BusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string | null;
}

/**
 * JSON canônico: chaves em ordem alfabética, sem espaços, apenas campos de negócio.
 * O valor já vem normalizado pelo Money ("25" e "25.00" geram o mesmo hash).
 * Header, messageId, occurredAt e a própria idempotencyKey ficam fora.
 */
export function canonicalBusinessJson(p: BusinessPayload): string {
  const fields: Record<string, string | null> = {
    amount: p.money.toAmountString(),
    currency: p.money.currency,
    externalTransactionId: p.externalTransactionId,
    gameId: p.gameId,
    kind: p.kind,
    playerId: p.playerId,
    providerId: p.providerId,
    referenceExternalTransactionId: p.referenceExternalTransactionId ?? null,
    roundId: p.roundId,
    walletId: p.walletId,
  };
  const sorted = Object.keys(fields)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(fields[k])}`);
  return `{${sorted.join(",")}}`;
}

/** SHA-256 (hex, 64 caracteres) do JSON canônico. */
export function payloadHash(p: BusinessPayload): string {
  return createHash("sha256").update(canonicalBusinessJson(p)).digest("hex");
}
