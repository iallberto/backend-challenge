import { FailureCode } from "../domain/wagering/failure-code";

/** Erros da camada de aplicação. Cada classe corresponde a uma categoria de resposta. */
export abstract class ApplicationError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
    public readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400: payload inválido. Nada é gravado. */
export class ValidationError extends ApplicationError {}

/** 403: o chamador não pode agir em nome do provider informado. Nada é gravado. */
export class AuthorizationError extends ApplicationError {}

/** 409: conflito de idempotência ou unicidade. Nada é alterado. */
export class ConflictError extends ApplicationError {}

/** 404 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** 503: falha transitória (banco/fila fora, lock timeout). Nada é gravado; reenviar resolve. */
export class TransientError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

/** Violação de unicidade detectada no commit. O caso de uso relê e decide replay/conflito. */
export class UniqueViolationError extends Error {
  constructor(public readonly constraint: string | undefined) {
    super(`Unique violation: ${constraint ?? "unknown"}`);
    this.name = "UniqueViolationError";
  }
}
