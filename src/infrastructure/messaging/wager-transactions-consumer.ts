import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { ApplicationError, TransientError } from "../../application/errors";
import type { FaultInjector, Logger } from "../../application/ports";
import type { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction";
import { parseOrThrow, sqsMessageSchema } from "../../application/validation";
import { WagerTransactionStatus } from "../../domain/wagering/enums";
import type { AppConfig } from "../config";
import { withLogContext } from "../observability/context";
import type { PromMetrics } from "../observability/metrics";
import { isTransientAwsError, queueUrl } from "./sqs";

export const CONSUMER_NAME = "wager-transactions-consumer";

/** O que fazer com a mensagem depois de processar (research.md R9). */
export type MessageAction = "ack" | "retry" | "leave";

/**
 * Classificação de erros:
 *  - negócio, validação, conflito, replay, duplicata → ack (reenviar não muda nada)
 *  - transitório (banco/fila fora, lock timeout)    → retry com backoff, sem ack
 *  - permanente com FAILED gravado                  → ack (o banco é o registro auditável)
 *  - ilegível ou erro sem registro possível          → leave: sem ack; após maxReceiveCount vai para a DLQ
 */
export function classifyError(error: unknown): MessageAction {
  if (error instanceof ApplicationError) return "ack";
  if (error instanceof TransientError || isTransientAwsError(error)) return "retry";
  return "leave";
}

export class WagerTransactionsConsumer {
  private running = false;
  private loop?: Promise<void>;
  private inFlight = new Set<string>();
  private abort = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: AppConfig,
    private readonly submit: SubmitWagerTransaction,
    private readonly logger: Logger,
    private readonly metrics: PromMetrics,
    private readonly fault: FaultInjector,
  ) {}

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  /** SIGTERM: para de buscar, espera o que está em andamento e devolve o resto à fila. */
  async stop(graceMs: number): Promise<void> {
    this.running = false;
    this.abort.abort();
    const deadline = Date.now() + graceMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    await this.loop?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const url = await this.waitForQueue();
    while (this.running) {
      let messages: Message[] = [];
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.sqs.waitSeconds,
            VisibilityTimeout: this.config.sqs.visibilitySeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = result.Messages ?? [];
      } catch (error) {
        if (!this.running) break;
        this.logger.warn({ err: (error as Error).message }, "sqs receive failed; retrying");
        await Bun.sleep(1000);
        continue;
      }
      for (const message of messages) {
        if (!this.running) {
          // desligando: devolve imediatamente as mensagens ainda não iniciadas
          await this.changeVisibility(url, message, 0);
          continue;
        }
        await this.handle(url, message);
      }
    }
  }

  private async handle(url: string, message: Message): Promise<void> {
    const receipt = message.ReceiptHandle!;
    this.inFlight.add(receipt);
    try {
      const action = await this.process(message);
      if (action === "ack") {
        this.fault.at("crash_after_commit_before_ack");
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }));
      } else {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
        const delay = Math.min(
          this.config.sqs.retryMaxSeconds,
          this.config.sqs.retryBaseSeconds * 2 ** Math.max(0, receiveCount - 1),
        );
        if (action === "retry") this.metrics.retry("sqs_consumer");
        await this.changeVisibility(url, message, delay);
      }
      this.metrics.messagesConsumed.inc({ result: action });
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, "failed to settle sqs message");
    } finally {
      this.inFlight.delete(receipt);
    }
  }

  private async process(message: Message): Promise<MessageAction> {
    let parsed;
    try {
      parsed = parseOrThrow(sqsMessageSchema, JSON.parse(message.Body ?? ""));
    } catch (error) {
      if (error instanceof SyntaxError) {
        // ilegível: não há o que gravar; sem ack, até a DLQ
        this.logger.error({ sqsMessageId: message.MessageId }, "unreadable sqs message");
        return "leave";
      }
      this.logger.warn({ sqsMessageId: message.MessageId }, "invalid sqs message payload; acknowledging");
      return "ack";
    }
    const { data } = parsed;
    const correlationId = parsed.correlationId ?? parsed.messageId;
    return withLogContext(
      { correlationId, messageId: parsed.messageId, walletId: data.walletId, providerId: data.providerId },
      async () => {
        try {
          const result = await this.submit.execute({
            ...data,
            caller: { providerId: data.providerId }, // fila = canal interno confiável (README §2)
            correlationId,
            channel: "sqs",
            inbox: { consumerName: CONSUMER_NAME, messageId: parsed.messageId },
          });
          if (result.type === "result" && result.transaction.status === WagerTransactionStatus.Failed && !result.replay) {
            this.logger.error({ transactionId: result.transaction.id }, "transaction recorded as FAILED");
          }
          return "ack";
        } catch (error) {
          const action = classifyError(error);
          this.logger.warn({ err: (error as Error).message, action }, "sqs message processing error");
          return action;
        }
      },
    );
  }

  private async changeVisibility(url: string, message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, "failed to change message visibility");
    }
  }

  private async waitForQueue(): Promise<string> {
    for (;;) {
      try {
        return await queueUrl(this.sqs, this.config.sqs.inputQueue);
      } catch (error) {
        if (!this.running) throw error;
        await Bun.sleep(1000);
      }
    }
  }
}
