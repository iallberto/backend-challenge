import { z } from "zod";
import { FailureCode } from "../domain/wagering/failure-code";
import { ValidationError } from "./errors";

const uuid = z.string().uuid();
const id = z.string().min(1).max(200);
const money = z.object({ amount: z.string(), currency: z.string() }).strict();

/** Mesmo contrato para HTTP e SQS (FR-029). Regras monetárias ficam no Money. */
export const wagerTransactionPayloadSchema = z
  .object({
    providerId: id,
    externalTransactionId: id,
    playerId: uuid,
    walletId: uuid,
    roundId: id,
    gameId: id,
    kind: z.string().min(1),
    money,
    referenceExternalTransactionId: id.nullish(),
  })
  .strict();

export type WagerTransactionPayload = z.infer<typeof wagerTransactionPayloadSchema>;

export const openWalletPayloadSchema = z
  .object({ playerId: uuid, initialBalance: money })
  .strict();

export type OpenWalletPayload = z.infer<typeof openWalletPayloadSchema>;

export const sqsMessageSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().optional(),
  correlationId: z.string().max(200).optional(),
  data: wagerTransactionPayloadSchema.extend({ idempotencyKey: z.string().min(1).max(300) }).strict(),
});

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      FailureCode.InvalidPayload,
      "Invalid payload",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
