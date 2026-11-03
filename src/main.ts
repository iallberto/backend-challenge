import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { buildContainer } from "./container";
import { loadConfig } from "./infrastructure/config";
import { HttpErrorFilter } from "./interfaces/http/error-filter";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const container = await buildContainer(config);
  const { logger } = container;

  if (config.runMigrations) {
    await container.orm.getMigrator().up();
  }

  const app = await NestFactory.create(AppModule.register(container), { logger: ["error", "warn"] });
  app.useGlobalFilters(new HttpErrorFilter(logger));
  await app.listen(config.port);

  if (config.workers.consumer) container.consumer.start();
  if (config.workers.outbox) container.outbox.start();
  if (config.workers.pending) container.pendingWorker.start();
  logger.info({ port: config.port, workers: config.workers }, "wagering processor started");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down: finishing in-flight work");
    // 1. para de consumir e conclui (ou devolve) as mensagens em andamento
    await container.consumer.stop(config.shutdownGraceMs);
    // 2. para os workers depois do ciclo atual
    await Promise.all([container.outbox.stop(), container.pendingWorker.stop()]);
    await app.close();
    await container.orm.close(true);
    logger.info({}, "shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "fatal", msg: "boot failed", err: String(error?.stack ?? error) })}\n`);
  process.exit(1);
});
