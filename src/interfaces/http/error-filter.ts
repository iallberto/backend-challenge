import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  TransientError,
  ValidationError,
} from "../../application/errors";
import type { Logger } from "../../application/ports";
import { FailureCode } from "../../domain/wagering/failure-code";

export interface HttpErrorMapping {
  status: number;
  code: string;
  message: string;
  details?: unknown[];
  retryAfter?: number;
}

/** Erro → resposta HTTP, igual em todas as rotas (FR-040). */
export function mapError(error: unknown): HttpErrorMapping {
  if (error instanceof ValidationError) return { status: 400, code: error.code, message: error.message, details: error.details };
  if (error instanceof AuthorizationError) return { status: 403, code: error.code, message: error.message };
  if (error instanceof ConflictError) return { status: 409, code: error.code, message: error.message };
  if (error instanceof NotFoundError) return { status: 404, code: "NOT_FOUND", message: error.message };
  if (error instanceof TransientError) {
    return { status: 503, code: FailureCode.ServiceUnavailable, message: "Temporarily unavailable; retry with the same Idempotency-Key", retryAfter: 1 };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: status === 404 ? "NOT_FOUND" : FailureCode.InvalidPayload, message: error.message };
  }
  return { status: 500, code: FailureCode.InternalError, message: "Internal error" };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const mapped = mapError(error);
    if (mapped.status >= 500) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error), status: mapped.status }, "request failed");
    }
    if (mapped.retryAfter) res.setHeader("Retry-After", String(mapped.retryAfter));
    res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, ...(mapped.details?.length ? { details: mapped.details } : {}) },
    });
  }
}
