import { createHmac } from "node:crypto";
import { requireSecret } from "../config/secrets.js";
import { enqueueJob, registerJobHandler } from "../services/integrationQueue.js";
import { subscribe, toCloudEvent } from "../services/eventBus.js";
import { callExternal } from "./externalClient.js";

/**
 * Message-queue option for integrations (NFR-093). Integrations use REST and JSON; where a partner wants messages,
 * the platform publishes its events, as CloudEvents JSON, to a broker:
 *   MESSAGE_BROKER=pubsub        Google Cloud Pub/Sub (PUBSUB_PROJECT, PUBSUB_TOPIC_PREFIX; PUBSUB_EMULATOR_HOST for local use)
 *   MESSAGE_BROKER=jms-bridge    a JMS-compatible broker (ActiveMQ, Artemis, IBM MQ) through a bridge the partner runs, which
 *                                accepts a signed JSON POST (JMS_BRIDGE_URL, JMS_BRIDGE_SECRET, JMS_DESTINATION_PREFIX)
 * Publishing goes through the durable integration queue, so a broker outage delays messages but never loses them.
 */

export interface MessageBroker {
  readonly name: string;
  publish(topic: string, message: Record<string, unknown>, attributes?: Record<string, string>): Promise<void>;
}

type PostFn = (url: string, init: RequestInit) => Promise<Response>;
let post: PostFn | undefined;
export function setBrokerPostForTests(fn: PostFn | undefined): void {
  post = fn;
}
const send: PostFn = (url, init) => (post ? post(url, init) : callExternal("message-broker", url, init, { attempts: 1 }));

async function metadataToken(): Promise<string> {
  const response = await callExternal("gcp-metadata", "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } }, { attempts: 2 });
  if (!response.ok) throw new Error(`Could not get a Google access token (HTTP ${response.status}).`);
  return ((await response.json()) as { access_token: string }).access_token;
}

export class PubSubBroker implements MessageBroker {
  readonly name = "pubsub";
  constructor(private readonly project: string, private readonly prefix: string) {}
  async publish(topic: string, message: Record<string, unknown>, attributes: Record<string, string> = {}): Promise<void> {
    const emulator = process.env.PUBSUB_EMULATOR_HOST?.trim();
    const topicName = `${this.prefix}${topic}`.replace(/[^A-Za-z0-9._~%+-]/g, "-");
    const url = `${emulator ? `http://${emulator}` : "https://pubsub.googleapis.com"}/v1/projects/${this.project}/topics/${topicName}:publish`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!emulator) headers.authorization = `Bearer ${process.env.PUBSUB_ACCESS_TOKEN?.trim() || (await metadataToken())}`;
    const response = await send(url, { method: "POST", headers, body: JSON.stringify({ messages: [{ data: Buffer.from(JSON.stringify(message)).toString("base64"), attributes }] }) });
    if (!response.ok) throw new Error(`Pub/Sub publish failed with HTTP ${response.status}.`);
  }
}

export class JmsBridgeBroker implements MessageBroker {
  readonly name = "jms-bridge";
  constructor(private readonly url: string, private readonly destinationPrefix: string) {}
  async publish(topic: string, message: Record<string, unknown>, attributes: Record<string, string> = {}): Promise<void> {
    const body = JSON.stringify({ destination: `${this.destinationPrefix}${topic}`, type: "topic", headers: attributes, body: message });
    const response = await send(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-signature": createHmac("sha256", requireSecret("JMS_BRIDGE_SECRET")).update(body).digest("hex") },
      body
    });
    if (!response.ok) throw new Error(`JMS bridge answered HTTP ${response.status}.`);
  }
}

export function brokerFromEnv(env: Record<string, string | undefined> = process.env): MessageBroker | undefined {
  const kind = env.MESSAGE_BROKER?.trim().toLowerCase();
  if (!kind || kind === "none") return undefined;
  if (kind === "pubsub") {
    if (!env.PUBSUB_PROJECT?.trim()) throw new Error("PUBSUB_PROJECT is required for the pubsub broker.");
    return new PubSubBroker(env.PUBSUB_PROJECT.trim(), env.PUBSUB_TOPIC_PREFIX?.trim() ?? "aimltriage-");
  }
  if (kind === "jms-bridge") {
    const url = env.JMS_BRIDGE_URL?.trim();
    if (!url) throw new Error("JMS_BRIDGE_URL is required for the jms-bridge broker.");
    if (env.NODE_ENV === "production" && !/^https:\/\//i.test(url)) throw new Error("JMS_BRIDGE_URL must use https.");
    return new JmsBridgeBroker(url, env.JMS_DESTINATION_PREFIX?.trim() ?? "aimltriage.");
  }
  throw new Error("MESSAGE_BROKER must be pubsub, jms-bridge or none.");
}

export function registerBrokerPublishing(): void {
  registerJobHandler("broker.publish", async (payload) => {
    const broker = brokerFromEnv();
    if (!broker) return; // the broker was switched off after the job was queued
    await broker.publish(String(payload.topic), payload.message as Record<string, unknown>, payload.attributes as Record<string, string> | undefined);
  });
  subscribe({
    name: "message-broker",
    handle: async (event) => {
      if (!brokerFromEnv()) return;
      const message = toCloudEvent(event) as unknown as Record<string, unknown>;
      await enqueueJob({ type: "broker.publish", payload: { topic: event.type, message, attributes: { type: String(message.type), source: "/aimltriage" } }, correlationId: event.id });
    }
  });
}
