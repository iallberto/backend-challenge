import { uuid } from "./infra";

export interface Api {
  url: string;
}

export interface WalletInfo {
  id: string;
  playerId: string;
}

export async function createWallet(api: Api, amount = "100.00", currency = "BRL"): Promise<WalletInfo> {
  const playerId = uuid();
  const r = await fetch(`${api.url}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });
  if (r.status !== 201) throw new Error(`createWallet failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { id: string };
  return { id: body.id, playerId };
}

export interface WagerInput {
  kind: string;
  amount: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  reference?: string;
  roundId?: string;
  currency?: string;
  providerId?: string;
  callerProviderId?: string;
}

export function wagerBody(wallet: WalletInfo, w: WagerInput) {
  const externalTransactionId = w.externalTransactionId ?? `ext-${uuid()}`;
  const providerId = w.providerId ?? "provider-a";
  return {
    externalTransactionId,
    idempotencyKey: w.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: w.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: w.kind,
      money: { amount: w.amount, currency: w.currency ?? "BRL" },
      ...(w.reference ? { referenceExternalTransactionId: w.reference } : {}),
    },
  };
}

export interface SubmitResponse {
  status: number;
  body: {
    transactionId?: string;
    status?: string;
    failureCode?: string | null;
    balance?: { amount: string; currency: string } | null;
    idempotentReplay?: boolean;
    error?: { code: string };
  };
  externalTransactionId: string;
}

export async function submit(api: Api, wallet: WalletInfo, w: WagerInput): Promise<SubmitResponse> {
  const { body, idempotencyKey, externalTransactionId } = wagerBody(wallet, w);
  return submitRaw(api, body, idempotencyKey, w.callerProviderId ?? body.providerId, externalTransactionId);
}

export async function submitRaw(
  api: Api,
  body: unknown,
  idempotencyKey: string | undefined,
  callerProviderId: string,
  externalTransactionId = "",
): Promise<SubmitResponse> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-provider-id": callerProviderId };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const r = await fetch(`${api.url}/wagering/transactions`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as SubmitResponse["body"], externalTransactionId };
}

export async function getJson(api: Api, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await fetch(`${api.url}${path}`, init);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
