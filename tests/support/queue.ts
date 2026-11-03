import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { wagerBody, type WagerInput, type WalletInfo } from "./api";
import { queueUrl, sqs, uuid } from "./infra";

export const INPUT_QUEUE = "wager-transactions.fifo";
export const DLQ = "wager-transactions-dlq.fifo";
export const EVENTS_QUEUE = "wagering-events.fifo";

export function wagerMessage(wallet: WalletInfo, w: WagerInput, messageId = `msg-${uuid()}`) {
  const { body, idempotencyKey, externalTransactionId } = wagerBody(wallet, w);
  return {
    externalTransactionId,
    message: {
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey },
    },
  };
}

/** Publica na fila de entrada. Cada envio tem deduplicação SQS própria, para simular redelivery real. */
export async function sendRaw(body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(INPUT_QUEUE),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(),
    }),
  );
}

export async function sendWager(wallet: WalletInfo, w: WagerInput, messageId?: string) {
  const m = wagerMessage(wallet, w, messageId);
  await sendRaw(JSON.stringify(m.message), wallet.id);
  return m;
}

/** Lê e remove mensagens de uma fila até achar uma que satisfaça o predicado. */
export async function drainUntil(queue: string, predicate: (body: string) => boolean, timeoutMs = 30_000): Promise<string[]> {
  const url = await queueUrl(queue);
  const matches: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const m of r.Messages ?? []) {
      if (predicate(m.Body ?? "")) matches.push(m.Body ?? "");
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
    }
    if (matches.length > 0 && (r.Messages ?? []).length === 0) return matches;
  }
  return matches;
}
