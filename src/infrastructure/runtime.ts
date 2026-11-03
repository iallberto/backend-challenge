import type { Clock, FaultInjector, FaultPoint, IdGenerator } from "../application/ports";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: único e ordenável por tempo (compatível com os exemplos do README). */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/**
 * Ganchos de injeção de falha, ativados só por FAULT_INJECTION (testes).
 * Os pontos de "crash" matam o processo na hora, como um kill -9: nada de cleanup.
 */
export class EnvFaultInjector implements FaultInjector {
  constructor(private readonly active: string) {}

  at(point: FaultPoint): void {
    if (!this.active || this.active !== point) return;
    if (point === "permanent_error_in_use_case") {
      throw new Error("Injected permanent failure");
    }
    process.stderr.write(`{"level":"fatal","msg":"fault injection: ${point}"}\n`);
    process.exit(137);
  }
}
