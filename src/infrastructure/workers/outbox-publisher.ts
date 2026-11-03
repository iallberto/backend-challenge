import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/core";
import type { EntityManager, PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { Clock, FaultInjector, Logger, UnitOfWork } from "../../application/ports";
import type { AppConfig } from "../config";
import { queueUrl } from "../messaging/sqs";
import type { PromMetrics } from "../observability/metrics";

/**
 * Publica a outbox no SQS. Roda em toda instância; `FOR UPDATE SKIP LOCKED` faz cada
 * publisher pegar um lote diferente. Entrega at-least-once: uma queda entre publicar e
 * marcar `published_at` republica o evento com o mesmo eventId.
 */
export class OutboxPublisher {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopping = false;
  private current?: Promise<unknown>;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly orm: MikroORM<PostgreSqlDriver>,
    private readonly sqs: SQSClient,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: PromMetrics,
    private readonly fault: FaultInjector,
  ) {}

  start(): void {
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.current = this.tick()
        .catch((error) => this.logger.warn({ err: (error as Error).message }, "outbox publish cycle failed"))
        .finally(() => this.schedule(this.config.workers.outboxIntervalMs));
    }, ms);
  }

  /** Um ciclo: publica lotes até esvaziar o que está vencido. Devolve quantos publicou. */
  async tick(): Promise<number> {
    const url = await queueUrl(this.sqs, this.config.sqs.eventsQueue);
    let published = 0;
    for (;;) {
      const count = await this.publishBatch(url);
      published += count;
      if (count < 10 || this.stopping) break;
    }
    await this.updateLag();
    return published;
  }

  private publishBatch(url: string): Promise<number> {
    return this.uow.run(async (scope) => {
      const now = this.clock.now();
      const batch = await scope.claimDueOutbox(10, now);
      let published = 0;
      for (const message of batch) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: url,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: {
                eventType: { DataType: "String", StringValue: message.eventType },
              },
            }),
          );
          this.fault.at("crash_after_publish_before_mark");
          message.markPublished(this.clock.now());
          published += 1;
        } catch (error) {
          message.scheduleRetry(this.clock.now(), (error as Error).message);
          this.metrics.retry("outbox");
        }
        await scope.saveOutbox(message);
      }
      return published;
    });
  }

  private async updateLag(): Promise<void> {
    const em = this.orm.em.fork() as EntityManager;
    const rows = await em.execute<Array<{ lag: string | null }>>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS lag FROM outbox_message WHERE published_at IS NULL`,
    );
    this.metrics.outboxLag.set(Number(rows[0]?.lag ?? 0) || 0);
  }
}
