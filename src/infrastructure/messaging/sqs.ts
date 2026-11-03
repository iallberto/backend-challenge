import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../config";

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
    // usa sempre o endpoint configurado, não o host embutido na QueueUrl
    // (no LocalStack ele aponta para localhost.localstack.cloud, inválido dentro de containers)
    useQueueUrlAsEndpoint: false,
  });
}

const cache = new Map<string, string>();

export async function queueUrl(client: SQSClient, name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw new Error(`Queue ${name} not found`);
  cache.set(name, result.QueueUrl);
  return result.QueueUrl;
}

/** Erros de rede/serviço do SQS que justificam nova tentativa. */
export function isTransientAwsError(error: unknown): boolean {
  const e = error as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number }; code?: string };
  if (e?.$retryable) return true;
  const status = e?.$metadata?.httpStatusCode;
  if (status && status >= 500) return true;
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "TimeoutError", "NetworkingError"].includes(e?.code ?? e?.name ?? "");
}
