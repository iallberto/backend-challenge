import { EntitySchema } from "@mikro-orm/core";

/*
 * Modelos de persistência (Records). Ficam na infraestrutura e nunca chegam ao domínio:
 * os mappers convertem Record ↔ domínio pela factory `rehydrate` (research.md R2).
 * Dinheiro chega como string (NUMERIC) e só vira Money no mapper.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  resultWalletVersion?: number | null;
  attempts!: number;
  nextAttemptAt?: Date | null;
  expiresAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt?: Date | null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
  lastError?: string | null;
}

const timestamptz = { type: "Date", columnType: "timestamptz" } as const;
const money = { type: "decimal", columnType: "numeric(19,2)" } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallet",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", columnType: "char(3)" },
    balance: { ...money },
    version: { type: "integer" },
    createdAt: { ...timestamptz },
    updatedAt: { ...timestamptz },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transaction",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "text" },
    externalTransactionId: { type: "text" },
    idempotencyKey: { type: "text" },
    payloadHash: { type: "string", columnType: "char(64)" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "text" },
    gameId: { type: "text" },
    kind: { type: "text" },
    amount: { ...money },
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: { type: "text", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "text" },
    failureCode: { type: "text", nullable: true },
    resultBalance: { ...money, nullable: true },
    resultWalletVersion: { type: "integer", nullable: true },
    attempts: { type: "integer" },
    nextAttemptAt: { ...timestamptz, nullable: true },
    expiresAt: { ...timestamptz, nullable: true },
    createdAt: { ...timestamptz },
    updatedAt: { ...timestamptz },
    processedAt: { ...timestamptz, nullable: true },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entry",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "text" },
    amount: { ...money },
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    createdAt: { ...timestamptz },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_message",
  properties: {
    consumerName: { type: "text", primary: true },
    messageId: { type: "text", primary: true },
    payloadHash: { type: "string", columnType: "char(64)" },
    receivedAt: { ...timestamptz },
    processedAt: { ...timestamptz, nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_message",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "text" },
    eventVersion: { type: "integer" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { ...timestamptz },
    attempts: { type: "integer" },
    nextAttemptAt: { ...timestamptz },
    publishedAt: { ...timestamptz, nullable: true },
    lastError: { type: "text", nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
