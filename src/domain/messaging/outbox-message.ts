import { IntegrationEvent } from "../events/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** fração de variação aleatória, ex.: 0.2 = ±20 % */
  jitter: number;
  random?: () => number;
}

export const DEFAULT_OUTBOX_RETRY: RetryPolicy = { baseMs: 1_000, maxMs: 60_000, jitter: 0.2 };

/** Backoff exponencial com teto e jitter: base × 2^attempts, limitado a maxMs, ± jitter. */
export function backoffDelayMs(attempts: number, policy: RetryPolicy): number {
  const raw = Math.min(policy.maxMs, policy.baseMs * 2 ** attempts);
  const random = policy.random ?? Math.random;
  const variation = raw * policy.jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + variation));
}

/** Evento de integração gravado na mesma transação do efeito; publicado depois por um worker. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly eventVersion: number,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.eventVersion,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
      s.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._lastError = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff). */
  scheduleRetry(now: Date, error?: string, policy: RetryPolicy = DEFAULT_OUTBOX_RETRY): void {
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts, policy));
    this._attempts += 1;
    this._lastError = error?.slice(0, 500);
  }
}
