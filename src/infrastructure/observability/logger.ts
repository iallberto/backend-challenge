import pino from "pino";
import type { Logger } from "../../application/ports";
import { logContext } from "./context";

/** Campos que nunca podem aparecer nos logs: valores monetários e payloads completos. */
const REDACT = [
  "money",
  "amount",
  "balance",
  "initialBalance",
  "payload",
  "body",
  "data",
  "*.money",
  "*.amount",
  "*.balance",
  "*.payload",
];

export function createLogger(level: string, instanceId: string): Logger & { raw: pino.Logger } {
  const raw = pino({
    level,
    base: { service: "wagering-processor", instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT, remove: true },
    mixin: () => ({ ...(logContext.getStore() ?? {}) }),
  });
  return {
    raw,
    info: (fields, msg) => raw.info(fields, msg),
    warn: (fields, msg) => raw.warn(fields, msg),
    error: (fields, msg) => raw.error(fields, msg),
  };
}
