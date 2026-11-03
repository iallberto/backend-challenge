import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/core";
import type { PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { Logger } from "./application/ports";
import type { WalletReadModel } from "./application/queries";
import { OpenWallet } from "./application/use-cases/open-wallet";
import { ReconcileWallet } from "./application/use-cases/reconcile-wallet";
import { ReprocessPendingReference } from "./application/use-cases/reprocess-pending-reference";
import { SubmitWagerTransaction } from "./application/use-cases/submit-wager-transaction";
import type { AppConfig } from "./infrastructure/config";
import { WagerTransactionsConsumer } from "./infrastructure/messaging/wager-transactions-consumer";
import { createSqsClient } from "./infrastructure/messaging/sqs";
import { createLogger } from "./infrastructure/observability/logger";
import { PromMetrics } from "./infrastructure/observability/metrics";
import { createOrm } from "./infrastructure/persistence/orm";
import { MikroOrmReadModel } from "./infrastructure/persistence/read-model";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/unit-of-work";
import { EnvFaultInjector, SystemClock, UuidV7Generator } from "./infrastructure/runtime";
import { OutboxPublisher } from "./infrastructure/workers/outbox-publisher";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference-worker";

/** Composição manual das dependências (composition root). O domínio não conhece nada disto. */
export interface Container {
  config: AppConfig;
  logger: Logger;
  orm: MikroORM<PostgreSqlDriver>;
  sqs: SQSClient;
  metrics: PromMetrics;
  reads: WalletReadModel;
  openWallet: OpenWallet;
  submitWager: SubmitWagerTransaction;
  reconcileWallet: ReconcileWallet;
  consumer: WagerTransactionsConsumer;
  outbox: OutboxPublisher;
  pendingWorker: PendingReferenceWorker;
}

export async function buildContainer(config: AppConfig): Promise<Container> {
  const logger = createLogger(config.logLevel, config.instanceId);
  const orm = await createOrm(config.databaseUrl, config.dbPoolMax);
  const sqs = createSqsClient(config);
  const metrics = new PromMetrics();
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const fault = new EnvFaultInjector(config.faultInjection);
  const uow = new MikroOrmUnitOfWork(orm, config.lockTimeoutMs, metrics);
  const reads = new MikroOrmReadModel(orm);

  const submitWager = new SubmitWagerTransaction(uow, clock, ids, metrics, logger, fault, config.pending);
  const reprocess = new ReprocessPendingReference(uow, clock, ids, metrics, config.pending);

  return {
    config,
    logger,
    orm,
    sqs,
    metrics,
    reads,
    openWallet: new OpenWallet(uow, clock, ids, metrics),
    submitWager,
    reconcileWallet: new ReconcileWallet(reads, metrics, logger),
    consumer: new WagerTransactionsConsumer(sqs, config, submitWager, logger, metrics, fault),
    outbox: new OutboxPublisher(uow, orm, sqs, config, clock, logger, metrics, fault),
    pendingWorker: new PendingReferenceWorker(uow, reprocess, config, clock, logger),
  };
}
