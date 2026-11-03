import type { Clock, Logger, UnitOfWork } from "../../application/ports";
import type { ReprocessPendingReference } from "../../application/use-cases/reprocess-pending-reference";
import type { AppConfig } from "../config";

/** Lease: enquanto uma instância reprocessa um pendente, as outras não o pegam. */
const LEASE_MS = 30_000;

/** Reprocessa transações PENDING_REFERENCE vencidas. Roda em toda instância (SKIP LOCKED). */
export class PendingReferenceWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private current?: Promise<unknown>;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly reprocess: ReprocessPendingReference,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.running = true;
    this.schedule(this.config.workers.pendingIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.current = this.tick()
        .catch((error) => this.logger.warn({ err: (error as Error).message }, "pending reference cycle failed"))
        .finally(() => this.schedule(this.config.workers.pendingIntervalMs));
    }, ms);
  }

  async tick(): Promise<number> {
    const now = this.clock.now();
    const ids = await this.uow.run((scope) => scope.claimDuePending(20, now, new Date(now.getTime() + LEASE_MS)));
    for (const id of ids) {
      if (!this.running) break;
      try {
        await this.reprocess.execute(id);
      } catch (error) {
        // o lease expira e outra tentativa acontece depois
        this.logger.warn({ transactionId: id, err: (error as Error).message }, "pending reprocess failed");
      }
    }
    return ids.length;
  }
}
