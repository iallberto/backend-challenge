import { AsyncLocalStorage } from "node:async_hooks";

/** Campos de correlação propagados por toda a operação (FR-046). */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return logContext.run({ ...(logContext.getStore() ?? {}), ...ctx }, fn);
}
