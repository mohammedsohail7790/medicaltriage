import { TYPE_PREFIX, knownEventTypes } from "./eventBus.js";

// NFR-098 / NFR-164: definitions an API gateway and an event-catalogue tool can import. The gateway
// product itself (Google API Gateway or Apigee) is provisioned with the tenant infrastructure; this is
// the contract the application publishes for it, and the application refuses direct traffic when
// GATEWAY_REQUIRED=true (src/middleware/gatewayGuard.ts).

type Spec = { paths: Record<string, Record<string, Record<string, unknown>>> } & Record<string, unknown>;

export function buildGatewayDefinition(spec: Spec, backendUrl: string) {
  const operations = Object.entries(spec.paths).flatMap(([route, ops]) =>
    Object.entries(ops).map(([method, op]) => ({
      method: method.toUpperCase(),
      path: route,
      authenticated: Array.isArray(op.security) && (op.security as unknown[]).length > 0,
      hasRequestSchema: Boolean(op.requestBody)
    }))
  );
  return {
    backend: { address: backendUrl, forwardedHeaders: { "x-gateway-secret": "<GATEWAY_SHARED_SECRET>" }, pathTranslation: "APPEND_PATH_TO_ADDRESS" },
    authentication: { consumerTokens: "OAuth 2.0 client_credentials at POST /api/v1/oauth/token", userSessions: "Bearer JWT issued by POST /api/v1/auth/login" },
    policies: {
      rateLimiting: "Enforced by the application per consumer; the gateway may add a coarser per-key quota in front of it.",
      versioning: "/api/v1 and /api/v2 are routed to the same backend; deprecation is signalled with Deprecation and Sunset headers.",
      directAccess: "Refused by the application when GATEWAY_REQUIRED=true."
    },
    operations
  };
}

export function buildAsyncApi(version: string) {
  const channels: Record<string, unknown> = {};
  for (const type of knownEventTypes()) {
    channels[type] = {
      description: `Published when ${type} occurs. Delivered as a CloudEvents 1.0 envelope to webhooks, rules and the message broker.`,
      subscribe: { message: { $ref: "#/components/messages/PlatformEvent" } }
    };
  }
  channels["audit.{action}"] = {
    description: "Any other audited action is published as audit.<action in lower case>.",
    parameters: { action: { schema: { type: "string" } } },
    subscribe: { message: { $ref: "#/components/messages/PlatformEvent" } }
  };
  return {
    asyncapi: "2.6.0",
    info: { title: "IST Health Tele-Triage events", version, description: `Event types carry the prefix ${TYPE_PREFIX}. Payloads hold references and changed field names, never record contents.` },
    channels,
    components: {
      messages: {
        PlatformEvent: {
          contentType: "application/cloudevents+json",
          payload: {
            type: "object",
            required: ["specversion", "id", "source", "type", "time"],
            properties: {
              specversion: { type: "string", const: "1.0" }, id: { type: "string" }, source: { type: "string" },
              type: { type: "string" }, time: { type: "string", format: "date-time" }, subject: { type: "string" },
              data: { type: "object", additionalProperties: true }
            }
          }
        }
      }
    }
  };
}
