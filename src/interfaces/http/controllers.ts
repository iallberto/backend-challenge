import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { NotFoundError, ValidationError } from "../../application/errors";
import { ledgerCursor } from "../../application/queries";
import { openWalletPayloadSchema, parseOrThrow, wagerTransactionPayloadSchema } from "../../application/validation";
import { FailureCode } from "../../domain/wagering/failure-code";
import type { Container } from "../../container";
import { queueUrl } from "../../infrastructure/messaging/sqs";
import { withLogContext } from "../../infrastructure/observability/context";
import {
  httpStatusFor,
  presentLedgerEntry,
  presentSubmitResult,
  presentTransaction,
  presentWallet,
} from "./presenters";

export const CONTAINER = Symbol("CONTAINER");

const correlationOf = (req: Request): string => (req as Request & { correlationId: string }).correlationId;

/**
 * Identidade do chamador (decisão Q1): adaptador de DESENVOLVIMENTO, inseguro, lê X-Provider-Id.
 * Em produção seria substituído pelo adaptador JWT (Keycloak, client credentials), sem mudar o domínio.
 */
function devProviderIdentity(header: string | undefined): { providerId: string } {
  if (!header) throw new ValidationError(FailureCode.InvalidPayload, "X-Provider-Id header is required");
  return { providerId: header };
}

@Controller("wallets")
export class WalletsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown, @Req() req: Request) {
    const payload = parseOrThrow(openWalletPayloadSchema, body);
    const wallet = await this.c.openWallet.execute({ ...payload, correlationId: correlationOf(req) });
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const wallet = await this.c.reads.getWallet(assertUuid(walletId));
    if (!wallet) throw new NotFoundError("Wallet not found");
    return presentWallet(wallet, true);
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor?: string, @Query("limit") limitRaw?: string) {
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError(FailureCode.InvalidPayload, "limit must be an integer between 1 and 200");
    }
    const after = cursor ? ledgerCursor.decode(cursor) : null;
    if (cursor && after === null) throw new ValidationError(FailureCode.InvalidPayload, "invalid cursor");
    const id = assertUuid(walletId);
    if (!(await this.c.reads.getWallet(id))) throw new NotFoundError("Wallet not found");
    const page = await this.c.reads.getLedgerPage(id, after, limit);
    return {
      items: page.items.map(presentLedgerEntry),
      nextCursor: page.hasMore && page.lastSeq !== null ? ledgerCursor.encode(page.lastSeq) : null,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string) {
    return this.c.reconcileWallet.execute(assertUuid(walletId));
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-provider-id") providerHeader: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) throw new ValidationError(FailureCode.MissingIdempotencyKey, "Idempotency-Key header is required");
    const payload = parseOrThrow(wagerTransactionPayloadSchema, body);
    const caller = devProviderIdentity(providerHeader);
    return withLogContext({ walletId: payload.walletId, providerId: payload.providerId }, async () => {
      const result = await this.c.submitWager.execute({
        ...payload,
        idempotencyKey,
        caller,
        correlationId: correlationOf(req),
        channel: "http",
      });
      if (result.type !== "result") throw new Error("unexpected duplicate message on HTTP channel");
      res.status(httpStatusFor(result.transaction));
      return presentSubmitResult(result.transaction, result.replay);
    });
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string) {
    const tx = await this.c.reads.getTransaction(assertUuid(transactionId));
    if (!tx) throw new NotFoundError("Transaction not found");
    return presentTransaction(tx);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternal(@Param("providerId") providerId: string, @Param("externalTransactionId") externalId: string) {
    const tx = await this.c.reads.getTransactionByExternalId(providerId, externalId);
    if (!tx) throw new NotFoundError("Transaction not found");
    return presentTransaction(tx);
  }
}

@Controller()
export class OperationsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      withTimeout(this.c.orm.em.fork().getConnection().execute("SELECT 1"), 2000).then(() => "up", () => "down"),
      withTimeout(
        queueUrl(this.c.sqs, this.c.config.sqs.inputQueue).then((url) =>
          this.c.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] })),
        ),
        2000,
      ).then(() => "up", () => "down"),
    ]);
    const ok = postgres === "up" && sqs === "up";
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks: { postgres, sqs } };
  }

  @Get("metrics")
  async metrics(@Res() res: Response) {
    try {
      const url = await queueUrl(this.c.sqs, this.c.config.sqs.dlqQueue);
      const attrs = await withTimeout(
        this.c.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] })),
        1500,
      );
      this.c.metrics.dlqMessages.set(Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0));
    } catch {
      // métrica de DLQ fica com o último valor conhecido
    }
    res.setHeader("Content-Type", this.c.metrics.registry.contentType);
    res.send(await this.c.metrics.registry.metrics());
  }
}

function assertUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new NotFoundError("Not found");
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}
