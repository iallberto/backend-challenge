/**
 * Taxonomia estável de falhas (contracts/failure-codes.md). Códigos nunca são renomeados;
 * novos códigos só são adicionados.
 */
export enum FailureCode {
  // validação (400, não persistidos)
  InvalidPayload = "INVALID_PAYLOAD",
  InvalidMoney = "INVALID_MONEY",
  MissingIdempotencyKey = "MISSING_IDEMPOTENCY_KEY",
  MissingReference = "MISSING_REFERENCE",
  OpeningNotAllowed = "OPENING_NOT_ALLOWED",
  // autorização (403, não persistido)
  ProviderMismatch = "PROVIDER_MISMATCH",
  // conflitos (409)
  IdempotencyKeyConflict = "IDEMPOTENCY_KEY_CONFLICT",
  ExternalIdConflict = "EXTERNAL_ID_CONFLICT",
  WalletAlreadyExists = "WALLET_ALREADY_EXISTS",
  // negócio (422, persistidos como REJECTED)
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReferenceReversed = "REFERENCE_REVERSED",
  ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
  // infraestrutura
  ServiceUnavailable = "SERVICE_UNAVAILABLE",
  InternalError = "INTERNAL_ERROR",
}
