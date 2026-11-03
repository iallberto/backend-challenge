import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PurgeQueueCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import { buildContainer, type Container } from "../../src/container";
import { loadConfig } from "../../src/infrastructure/config";
import { createOrm } from "../../src/infrastructure/persistence/orm";
import { createWallet, submit, type Api } from "../support/api";
import { DATABASE_URL, assertReconciled, db, eventually, queueUrl, sqs, uuid } from "../support/infra";
import { type Instance, sharedInstance, startInstance } from "../support/instances";
import { INPUT_QUEUE, sendWager } from "../support/queue";

let api: Api;
beforeAll(async () => {
  api = await sharedInstance();
});

describe("Worker morto depois do commit e antes do ack (SQS)", () => {
  test("a mensagem volta, a inbox reconhece e não há novo efeito", async () => {
    const w = await createWallet(api, "100.00");
    // sobras de outros testes fariam a instância morrer ao confirmar outra mensagem
    await sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(INPUT_QUEUE) }));
    const doomed = await startInstance({ FAULT_INJECTION: "crash_after_commit_before_ack", OUTBOX_ENABLED: "false", PENDING_WORKER_ENABLED: "false" });
    const m = await sendWager(w, { kind: "BET", amount: "40.00" });
    expect(await doomed.exited).toBe(137); // morreu exatamente entre o commit e o DeleteMessage
    const [committed] = await db`SELECT status FROM wager_transaction WHERE external_transaction_id = ${m.externalTransactionId}`;
    expect(committed.status).toBe("PROCESSED");

    const survivor = await startInstance({ OUTBOX_ENABLED: "false", PENDING_WORKER_ENABLED: "false" });
    try {
      // após o visibility timeout (5 s nos testes) a mensagem reaparece e é confirmada como duplicata
      await eventually(
        async () => {
          const metrics = await (await fetch(`${survivor.url}/metrics`)).text();
          return /idempotency_duplicates_total\{channel="sqs"\} [1-9]/.test(metrics);
        },
        { timeoutMs: 30_000, label: "redelivery detected as duplicate" },
      );
      const rows = await db`SELECT 1 FROM wager_transaction WHERE external_transaction_id = ${m.externalTransactionId}`;
      expect(rows).toHaveLength(1);
      expect((await assertReconciled(w.id)).balance).toBe("60.00");
    } finally {
      await survivor.stop();
    }
  });
});

describe("Processo morto depois do commit e antes de publicar (outbox)", () => {
  test("outra instância publica o evento confirmado", async () => {
    const w = await createWallet(api, "100.00");
    const doomed = await startInstance({ FAULT_INJECTION: "crash_after_commit_before_publish", OUTBOX_ENABLED: "false", CONSUMER_ENABLED: "false" });
    const ext = `crash-pub-${uuid()}`;
    await submit(doomed, w, { kind: "BET", amount: "10.00", externalTransactionId: ext }).catch(() => undefined);
    expect(await doomed.exited).toBe(137);
    const [tx] = await db`SELECT id, status FROM wager_transaction WHERE external_transaction_id = ${ext}`;
    expect(tx.status).toBe("PROCESSED");
    // a instância compartilhada (outbox ligado) publica o que o processo morto deixou
    await eventually(async () => {
      const rows = await db`SELECT published_at FROM outbox_message WHERE payload->'data'->>'transactionId' = ${tx.id}`;
      return rows.length === 2 && rows.every((r: { published_at: Date | null }) => r.published_at !== null);
    });
    expect((await assertReconciled(w.id)).balance).toBe("90.00");
  });
});

describe("Publishers concorrentes sobre a mesma outbox (banco isolado)", () => {
  const scratch = `wagering_outbox_${Date.now()}`;
  let url: string;
  let probe: SQL;
  const containers: Container[] = [];
  const sends = new Map<string, number>();

  const makeContainer = async () => {
    const c = await buildContainer({ ...loadConfig(), databaseUrl: url, logLevel: "warn" });
    const original = c.sqs.send.bind(c.sqs);
    // instrumenta o cliente REAL (as mensagens continuam indo ao LocalStack) para contar envios
    c.sqs.send = ((command: unknown, options?: unknown) => {
      if (command instanceof SendMessageCommand) {
        const id = command.input.MessageDeduplicationId!;
        sends.set(id, (sends.get(id) ?? 0) + 1);
      }
      return (original as (c: unknown, o?: unknown) => Promise<unknown>)(command, options);
    }) as typeof c.sqs.send;
    containers.push(c);
    return c;
  };

  const insertEvents = async (n: number) => {
    const ids = Array.from({ length: n }, () => Bun.randomUUIDv7());
    for (const id of ids) {
      await probe`INSERT INTO outbox_message (id, aggregate_id, event_type, event_version, payload, occurred_at, attempts, next_attempt_at)
                  VALUES (${id}, ${uuid()}, 'TestEvent', 1, ${JSON.stringify({ eventId: id })}::jsonb, now(), 0, now())`;
    }
    return ids;
  };

  beforeAll(async () => {
    await db.unsafe(`CREATE DATABASE ${scratch}`);
    url = DATABASE_URL.replace(/\/[^/]+$/, `/${scratch}`);
    const orm = await createOrm(url, 2);
    await orm.getMigrator().up();
    await orm.close(true);
    probe = new SQL(url);
  });
  afterAll(async () => {
    for (const c of containers) await c.orm.close(true);
    await probe?.close();
    await db.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  });

  test("dois publishers ao mesmo tempo: todos os eventos publicados, nenhum enviado duas vezes", async () => {
    const [a, b] = [await makeContainer(), await makeContainer()];
    const ids = await insertEvents(60);
    const [na, nb] = await Promise.all([a.outbox.tick(), b.outbox.tick()]);
    expect(na + nb).toBe(60);
    const pending = await probe`SELECT COUNT(*)::int AS n FROM outbox_message WHERE published_at IS NULL`;
    expect(pending[0].n).toBe(0);
    for (const id of ids) expect(sends.get(id)).toBe(1);
  });

  test("publisher morre depois de publicar e antes de marcar → outro republica com o MESMO eventId", async () => {
    const [eventId] = await insertEvents(1);
    const doomed = await startInstance({
      DATABASE_URL: url,
      FAULT_INJECTION: "crash_after_publish_before_mark",
      CONSUMER_ENABLED: "false",
      PENDING_WORKER_ENABLED: "false",
    });
    expect(await doomed.exited).toBe(137);
    const [row] = await probe`SELECT published_at FROM outbox_message WHERE id = ${eventId!}`;
    expect(row.published_at).toBeNull(); // a transação do lote foi desfeita com a queda
    const c = containers[0] ?? (await makeContainer());
    await c.outbox.tick();
    const [after] = await probe`SELECT published_at FROM outbox_message WHERE id = ${eventId!}`;
    expect(after.published_at).not.toBeNull();
    expect(sends.get(eventId!)).toBe(1); // + 1 envio do processo morto = duplicata segura (mesmo eventId)
  });
});

describe("Reinício do serviço com consistência final", () => {
  let fleet: Instance[] = [];
  afterAll(async () => {
    await Promise.all(fleet.map((i) => i.stop().catch(() => undefined)));
  });

  test("carga em 3 instâncias, uma morre no meio (kill -9) e volta: todas as wallets reconciliam", async () => {
    fleet = await Promise.all([1, 2, 3].map(() => startInstance({ CONSUMER_ENABLED: "false" })));
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(fleet[0]!, "500.00")));
    const load = (rounds: number) =>
      Promise.all(
        Array.from({ length: rounds }, (_, i) =>
          submit(fleet[i % fleet.length]!, wallets[i % wallets.length]!, { kind: i % 3 ? "BET" : "WIN", amount: "3.33" }).catch(() => undefined),
        ),
      );
    const inFlight = load(150);
    await Bun.sleep(150);
    await fleet[1]!.kill(); // queda abrupta no meio da carga
    await inFlight;
    fleet[1] = await startInstance({ CONSUMER_ENABLED: "false" });
    await load(60);
    for (const w of wallets) await assertReconciled(w.id);
    const negative = await db`SELECT COUNT(*)::int AS n FROM wallet WHERE balance < 0`;
    expect(negative[0].n).toBe(0);
    // e todos os eventos confirmados acabam publicados
    await eventually(
      async () => {
        const rows = await db`SELECT COUNT(*)::int AS n FROM outbox_message o
                               JOIN wager_transaction t ON t.id::text = o.payload->'data'->>'transactionId'
                              WHERE t.wallet_id = ANY(${wallets.map((w) => w.id)}::uuid[]) AND o.published_at IS NULL`;
        return rows[0].n === 0;
      },
      { timeoutMs: 30_000, label: "outbox drained" },
    );
  });
});
