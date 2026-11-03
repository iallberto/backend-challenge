import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Metrics } from "../../application/ports";

/** Métricas mínimas do README §12, no formato Prometheus (GET /metrics). */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Transações decididas, por status e kind",
    labelNames: ["status", "kind"],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "idempotency_duplicates_total",
    help: "Duplicatas detectadas (replay de idempotência ou mensagem já vista na inbox)",
    labelNames: ["channel"],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "retries_total",
    help: "Novas tentativas agendadas, por componente",
    labelNames: ["component"],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wallet_lock_conflicts_total",
    help: "Esperas de lock que estouraram o lock_timeout",
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: "reconciliation_divergences_total",
    help: "Reconciliações que encontraram saldo diferente do ledger",
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: "processing_duration_seconds",
    help: "Latência de processamento de uma transação de aposta",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: "outbox_lag_seconds",
    help: "Idade do evento pendente mais antigo da outbox",
    registers: [this.registry],
  });
  readonly dlqMessages = new Gauge({
    name: "dlq_messages",
    help: "Mensagens na DLQ (ApproximateNumberOfMessages)",
    registers: [this.registry],
  });
  readonly messagesConsumed = new Counter({
    name: "sqs_messages_total",
    help: "Mensagens SQS tratadas, por resultado",
    labelNames: ["result"],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transaction(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }
  duplicate(channel: "http" | "sqs"): void {
    this.duplicates.inc({ channel });
  }
  retry(component: string): void {
    this.retries.inc({ component });
  }
  lockConflict(): void {
    this.lockConflicts.inc();
  }
  observeProcessing(seconds: number): void {
    this.processing.observe(seconds);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
