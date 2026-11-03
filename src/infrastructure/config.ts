const env = (name: string, fallback?: string): string => {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing environment variable ${name}`);
};

const int = (name: string, fallback: number): number => Number.parseInt(env(name, String(fallback)), 10);
const bool = (name: string, fallback: boolean): boolean => env(name, String(fallback)) === "true";

/** Configuração lida uma vez, no boot. Valores padrão = .env.example. */
export function loadConfig() {
  return {
    port: int("PORT", 3100),
    instanceId: env("INSTANCE_ID", `${process.pid}`),
    databaseUrl: env("DATABASE_URL", "postgres://wagering:wagering@localhost:55432/wagering"),
    dbPoolMax: int("DB_POOL_MAX", 20),
    lockTimeoutMs: int("LOCK_TIMEOUT_MS", 5000),
    aws: {
      region: env("AWS_REGION", "us-east-1"),
      endpoint: env("SQS_ENDPOINT", "http://localhost:4566"),
      accessKeyId: env("AWS_ACCESS_KEY_ID", "test"),
      secretAccessKey: env("AWS_SECRET_ACCESS_KEY", "test"),
    },
    sqs: {
      inputQueue: env("SQS_INPUT_QUEUE", "wager-transactions.fifo"),
      dlqQueue: env("SQS_DLQ_QUEUE", "wager-transactions-dlq.fifo"),
      eventsQueue: env("SQS_EVENTS_QUEUE", "wagering-events.fifo"),
      waitSeconds: int("SQS_WAIT_SECONDS", 20),
      visibilitySeconds: int("SQS_VISIBILITY_SECONDS", 30),
      retryBaseSeconds: int("SQS_RETRY_BASE_SECONDS", 2),
      retryMaxSeconds: int("SQS_RETRY_MAX_SECONDS", 60),
    },
    workers: {
      consumer: bool("CONSUMER_ENABLED", true),
      outbox: bool("OUTBOX_ENABLED", true),
      pending: bool("PENDING_WORKER_ENABLED", true),
      outboxIntervalMs: int("OUTBOX_INTERVAL_MS", 500),
      pendingIntervalMs: int("PENDING_INTERVAL_MS", 1000),
    },
    pending: {
      backoffBaseMs: int("PENDING_BACKOFF_BASE_MS", 1000),
      backoffMaxMs: int("PENDING_BACKOFF_MAX_MS", 300_000),
      ttlMs: int("PENDING_TTL_MS", 3_600_000),
    },
    faultInjection: env("FAULT_INJECTION", ""),
    logLevel: env("LOG_LEVEL", "info"),
    runMigrations: bool("RUN_MIGRATIONS", false),
    shutdownGraceMs: int("SHUTDOWN_GRACE_MS", 20_000),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
