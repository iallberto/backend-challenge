import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { DATABASE_URL, SQS_ENDPOINT, eventually } from "./infra";

const ROOT = join(import.meta.dir, "..", "..");
const LOG_DIR = join(ROOT, "tests", ".logs");
mkdirSync(LOG_DIR, { recursive: true });

let nextPort = 3200 + Math.floor(Math.random() * 300);

export interface Instance {
  url: string;
  port: number;
  proc: Subprocess;
  /** SIGKILL: morte abrupta, sem cleanup (simula queda). */
  kill(): Promise<void>;
  /** SIGTERM: desligamento gracioso. */
  stop(): Promise<number | null>;
  exited: Promise<number>;
}

/** Defaults rápidos para testes: polling curto, backoff curto, prazo de pendentes curto. */
export const FAST_ENV: Record<string, string> = {
  SQS_WAIT_SECONDS: "1",
  SQS_VISIBILITY_SECONDS: "5",
  SQS_RETRY_BASE_SECONDS: "1",
  SQS_RETRY_MAX_SECONDS: "1",
  OUTBOX_INTERVAL_MS: "200",
  PENDING_INTERVAL_MS: "200",
  PENDING_BACKOFF_BASE_MS: "200",
  PENDING_BACKOFF_MAX_MS: "1000",
  PENDING_TTL_MS: "6000",
  LOG_LEVEL: "info",
};

const running = new Set<Instance>();

/** Sobe uma instância real da aplicação como processo separado (Bun.spawn). */
export async function startInstance(env: Record<string, string> = {}): Promise<Instance> {
  const port = nextPort++;
  const logFile = Bun.file(join(LOG_DIR, `instance-${port}.log`));
  const proc = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...FAST_ENV,
      DATABASE_URL,
      SQS_ENDPOINT,
      PORT: String(port),
      INSTANCE_ID: `test-${port}`,
      ...env,
    },
    stdout: logFile,
    stderr: logFile,
  });
  const instance: Instance = {
    url: `http://localhost:${port}`,
    port,
    proc,
    exited: proc.exited,
    async kill() {
      proc.kill("SIGKILL");
      await proc.exited;
      running.delete(instance);
    },
    async stop() {
      proc.kill("SIGTERM");
      const code = await proc.exited;
      running.delete(instance);
      return code;
    },
  };
  running.add(instance);
  await eventually(
    async () => {
      if (proc.exitCode !== null) throw new Error(`instance on ${port} exited with ${proc.exitCode}`);
      const r = await fetch(`${instance.url}/health/live`);
      return r.ok;
    },
    { timeoutMs: 30_000, label: `instance on port ${port}` },
  );
  return instance;
}

let shared: Promise<Instance> | undefined;

/**
 * Instância HTTP compartilhada pelos testes de API: sem consumidor SQS (os testes de fila sobem
 * as próprias), com outbox e worker de pendentes ligados.
 */
export function sharedInstance(): Promise<Instance> {
  shared ??= startInstance({ CONSUMER_ENABLED: "false" });
  return shared;
}

process.on("exit", () => {
  for (const i of running) i.proc.kill("SIGKILL");
});
