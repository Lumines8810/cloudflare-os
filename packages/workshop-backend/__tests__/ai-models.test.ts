import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel, type ModelHandle, type ModelRoutingOptions } from "../src/ai-models.js";
import {
  AiRequestGuardError,
  type AiRequestGuard,
} from "../src/ai-gateway-billing/limits/ai-budget.js";

// These tests exercise the real pi-ai stack: no module mocks. Routing decisions are asserted on
// the returned handle's model descriptor (baseUrl/id/api) and log route, and request-level
// behavior (URLs, auth headers, gateway metadata) is asserted by driving `handle.stream` with an
// injected `options.fetch` stub. pi streams never reject; a stubbed 400 simply ends the stream
// with an error-stop message once the request has been captured.

const INITIATOR: AiChatAuthorInfo = {
  type: "user",
  id: "user-123",
  name: "User",
};

const GADGET_INITIATOR: AiChatAuthorInfo = {
  type: "gadget",
  id: "owner-456",
  name: "Report Gadget",
};

const ANTHROPIC_CONFIG: AiModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  apiToken: "ignored-in-gateway-mode",
};

const WORKERS_AI_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  apiToken: "ignored-in-gateway-mode",
};

describe("Workers AI image capabilities", () => {
  beforeEach(() => { capturedRequests.length = 0; });

  const config: AiModelConfig = {
    provider: "cloudflare",
    model: "@cf/zai-org/glm-5.3-flash",
    apiToken: "test-token",
    accountId: "test-account",
  };

  for (const route of ["binding", "platform", "user", "direct"] as const) {
    it(`preserves GLM-5.3-Flash PNG bytes through the real SDK (${route})`, async () => {
      const handle = getModel(env({
        ...(route === "direct" ? { CF_AI_GATEWAY: undefined } : {}),
        ...(route === "binding" ? {
          CF_AI_GATEWAY_API_TOKEN: undefined,
          CF_AI_GATEWAY_PROVIDERS: "cloudflare",
          WORKERS_AI: { fetch: fetchStub } as unknown as Ai,
        } : {}),
      }), config, INITIATOR, route === "user" ? {
        userGateway: { accountId: "user-account", apiKey: "user-token" },
      } : {});
      const stream = handle.stream(handle.model, {
        messages: [{ role: "user", timestamp: 0, content: [
          { type: "text", text: "Read this synthetic image; do not call tools." },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ] }],
      }, { ...(route === "binding" ? {} : { fetch: fetchStub }), maxRetries: 0 });
      expect((await stream.result()).stopReason).toBe("error");
      expect(capturedRequests).toHaveLength(1);
      const request = capturedRequests[0];
      expect(JSON.parse(request.body).messages[0].content).toContainEqual({
        type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      });
      expect(request.body).not.toContain("image omitted");
      expect(handle.model.input).toEqual(["text", "image"]);
      if (route === "binding") {
        expect(request.url).toBe(
          "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/workers-ai/v1/chat/completions");
        expect(request.headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-gateway-binding");
      }
    }, 15000);
  }

  it("does not grant image support to unknown or known text-only models", () => {
    for (const model of ["@cf/example/unknown", WORKERS_AI_CONFIG.model]) {
      expect(getModel(env(), { ...config, model }, INITIATOR).model.input).toEqual(["text"]);
    }
  });
});

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google",
    ...overrides,
  } as Cloudflare.Env;
}

function userRouting(token: string): Pick<ModelRoutingOptions, "users"> {
  return { users: {
    idFromString: (id: string) => id,
    get: () => ({ getChatgptAccessToken: async () => token }),
  } as unknown as ModelRoutingOptions["users"] };
}

type CapturedRequest = { url: string; headers: Headers; body: string };

const capturedRequests: CapturedRequest[] = [];

const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input as RequestInfo, init);
  capturedRequests.push({ url: request.url, headers: request.headers, body: await request.text() });
  // A non-retryable client error: the provider SDK reports it, pi converts it into an
  // error-stop assistant message, and the request stays captured for assertions.
  return Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
}) as typeof fetch;

// Runs one request through the handle with the fetch stub and returns what was sent.
async function captureRequest(handle: ModelHandle): Promise<CapturedRequest> {
  const stream = await handle.stream(handle.model, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, { fetch: fetchStub, maxRetries: 0 });
  const message = await stream.result();
  expect(message.stopReason).toBe("error");
  expect(capturedRequests.length).toBeGreaterThan(0);
  return capturedRequests[0];
}

describe("getModel AI Gateway routing", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("routes non-Workers providers through the platform gateway", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR, {
      metadata: { source: "chat", gadgetId: "gadget-123", chatId: 7 },
    });

    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.id).toBe("claude-sonnet-4-5");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic/" +
        "v1/messages");
    // Gateway-owned auth: the cf-aig token authorizes the request and the SDK's own auth
    // headers are suppressed so the gateway's server-managed provider keys apply.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-123",
      chatId: 7,
    });
  }, 15000);

  it("routes Google through the gateway's google-ai-studio passthrough", () => {
    // The @google/genai SDK sends its API key as `x-goog-api-key`, which AI Gateway forwards to
    // the provider verbatim (taking precedence over the gateway's stored keys), so the documented
    // stored-key flow passes the gateway token as the SDK API key. The adapter rejects injected
    // fetch, so only the descriptor is asserted here; the header behavior is the SDK's.
    const handle = getModel(env(), {
      provider: "google",
      model: "gemini-2.5-flash",
      apiToken: "ignored-in-gateway-mode",
    }, INITIATOR);

    expect(handle.model.api).toBe("google-generative-ai");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/" +
        "google-ai-studio/v1beta");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });
  });

  it("preserves gadget automation metadata", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, GADGET_INITIATOR, {
      metadata: { source: "thread-title", gadgetId: "gadget-456", chatId: 8 },
    });

    const request = await captureRequest(handle);
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "owner-456",
      source: "thread-title",
      gadgetId: "gadget-456",
      chatId: 8,
      automated: true,
    });
  }, 15000);

  it("requires the gateway account id whenever gateway mode is enabled", () => {
    expect(() => getModel(env({ CF_AI_GATEWAY_ACCOUNT_ID: undefined }), ANTHROPIC_CONFIG,
        INITIATOR)).toThrow("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
  });

  it("requires a transport: the Workers AI binding or an API token", () => {
    // Without the binding (local dev without --use-workers-ai-binding), the token is required.
    expect(() => getModel(env({ CF_AI_GATEWAY_API_TOKEN: undefined }), ANTHROPIC_CONFIG,
        INITIATOR)).toThrow("AI Gateway mode needs a transport");
  });

  it("prioritizes a connected user's Gateway over platform routing", async () => {
    const handle = getModel(env(), WORKERS_AI_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
      metadata: { source: "chat", gadgetId: "gadget-789", chatId: 9 },
    });

    // BYOK rides the user's default gateway's provider-native routes (unified *billing* has no
    // API requirements), regardless of the platform gateway configuration. For Workers AI that
    // is its own OpenAI-compatible endpoint under workers-ai/v1.
    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "default",
      accountId: "user-account-id",
      apiToken: "user-token",
    });

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/workers-ai/v1/" +
        "chat/completions");
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer user-token");
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-789",
      chatId: 9,
    });
  }, 15000);

  it("speaks the provider's native API on a connected user's Gateway", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
    });

    // Never the gateway's unified OpenAI-compat translation layer: it drops provider features
    // (extended thinking, cache_control prompt caching, the Responses API).
    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.id).toBe("claude-sonnet-4-5");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/anthropic");

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/anthropic/v1/messages");
    // The user's token authorizes the gateway; the SDK's own auth headers are suppressed so the
    // gateway's unified-billing provider keys apply.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer user-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
  }, 15000);

  it("routes Workers AI through the platform gateway like every other provider", async () => {
    const handle = getModel(env(), WORKERS_AI_CONFIG, INITIATOR,
        { sessionAffinity: "session-a" });

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/workers-ai/" +
        "v1/chat/completions");
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    // Session affinity flows through (Workers AI models opt in to the affinity headers).
    expect(request.headers.get("x-session-affinity")).toBe("session-a");
  }, 15000);
});

describe("guarded model requests", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("denies before constructing a provider request", async () => {
    let fetchCalls = 0;
    const guard: AiRequestGuard = {
      reserve: async () => {
        throw new AiRequestGuardError("budget-denied", "daily budget exhausted");
      },
      settle: async () => {},
    };
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR, {aiRequestGuard: guard});

    const stream = handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {fetch: async () => {
      fetchCalls++;
      return new Response(null, {status: 500});
    }});
    const message = await stream.result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("daily budget exhausted");
    expect(fetchCalls).toBe(0);
    expect(handle.lastFailure).toEqual({kind: "budget-denied"});
  });

  it("disables provider retries and settles a 429 as a rate limit", async () => {
    const settled: string[] = [];
    const guard: AiRequestGuard = {
      reserve: vi.fn(async () => ({reservationId: "reservation-1"})),
      settle: vi.fn(async (_id, outcome) => { settled.push(outcome); }),
    };
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      capturedRequests.push({
        url: request.url,
        headers: request.headers,
        body: await request.text(),
      });
      return Response.json(
          {error: {type: "rate_limit_error", message: "try later"}}, {status: 429});
    });
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR, {aiRequestGuard: guard});

    const stream = handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {fetch: fetchSpy});
    const message = await stream.result();

    expect(message.stopReason).toBe("error");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(guard.reserve).toHaveBeenCalledTimes(1);
    expect(settled).toEqual(["rate-limit"]);
    expect(handle.lastFailure?.kind).toBe("rate-limit");
  }, 15000);
});

describe("getModel AI Gateway binding transport", () => {
  // Provider-native requests captured by the fake Workers AI binding. In binding mode the
  // handle's requests never hit HTTP: pi's SDK fetch is the gateway-binding shim, which only
  // rewrites the URL onto the gateway's provider passthrough
  // (workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...) and hands the request to
  // binding.fetch() otherwise unchanged.
  type CapturedBindingRequest = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  const capturedEntries: CapturedBindingRequest[] = [];

  const fakeBinding = {
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      capturedEntries.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      // Same non-retryable client error as the HTTP fetch stub: pi surfaces an error-stop
      // message and the request stays captured for assertions.
      return Response.json(
          { error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
    },
  } as unknown as Ai;

  // Binding transport selects by default: binding present, no API token (in-account gateways;
  // CF_AI_GATEWAY_USE_BINDING=false is the cross-account opt-out). google must not be an
  // enabled provider in this mode (its transport still needs the token).
  function bindingEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
    return env({
      CF_AI_GATEWAY_API_TOKEN: undefined,
      CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare",
      WORKERS_AI: fakeBinding,
      ...overrides,
    });
  }

  async function captureEntry(handle: ModelHandle): Promise<CapturedBindingRequest> {
    const stream = handle.stream(handle.model, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, { maxRetries: 0 });
    const message = await stream.result();
    expect(message.stopReason).toBe("error");
    expect(capturedEntries.length).toBeGreaterThan(0);
    return capturedEntries[0];
  }

  beforeEach(() => {
    capturedEntries.length = 0;
    capturedRequests.length = 0;
  });

  it("drives Anthropic through the binding with no API token", async () => {
    const handle = getModel(bindingEnv(), ANTHROPIC_CONFIG, INITIATOR, {
      metadata: { source: "chat", gadgetId: "gadget-123", chatId: 7 },
    });

    expect(handle.model.api).toBe("anthropic-messages");
    // Binding-routed models address the gateway on the binding's host, which takes no account
    // id -- the binding channel carries identity.
    expect(handle.model.baseUrl).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic");
    // Same-account log reads ride the binding too: no account id or token in the route.
    expect(handle.aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });

    const entry = await captureEntry(handle);
    expect(entry.url).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic/v1/messages");
    expect(entry.method).toBe("POST");
    // The sentinel auth header satisfies pi's request-auth check; the gateway recognizes and
    // strips it on binding-routed requests, so the shim forwards it. The SDK's own auth
    // headers stay suppressed.
    expect(entry.headers["cf-aig-authorization"]).toBe("Bearer cloudflare-gateway-binding");
    const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("authorization");
    expect(JSON.parse(entry.headers["cf-aig-metadata"])).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-123",
      chatId: 7,
    });
    expect((JSON.parse(entry.body) as { model: string }).model).toBe("claude-sonnet-4-5");
  }, 15000);

  it("drives Workers AI through the binding via its gateway route", async () => {
    const handle = getModel(bindingEnv(), WORKERS_AI_CONFIG, INITIATOR);

    expect(handle.model.baseUrl).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });

    const entry = await captureEntry(handle);
    expect(entry.url).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/workers-ai/" +
        "v1/chat/completions");
    expect((JSON.parse(entry.body) as { model: string }).model)
        .toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // openai-completions adapters inject `Authorization: Bearer unused` under header-owned
    // auth; the gatewayAuthHeaders nulls must delete it before dispatch, else the gateway
    // would treat it as a request-supplied provider key overriding stored keys.
    const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("x-api-key");
  }, 15000);

  it("lets a per-call fetch override the binding transport", async () => {
    // Tests and diagnostics inject options.fetch; it must win over the handle's binding fetch.
    // The URL is the model's, so it still names the binding route -- only the transport swaps.
    const handle = getModel(bindingEnv(), ANTHROPIC_CONFIG, INITIATOR);

    const request = await captureRequest(handle);
    expect(capturedEntries).toHaveLength(0);
    expect(request.url).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic/v1/messages");
    expect(request.headers.get("cf-aig-authorization"))
        .toBe("Bearer cloudflare-gateway-binding");
  }, 15000);

  it("keeps Google on HTTPS with the token while other providers use the binding", async () => {
    // Hybrid mode: binding and token both present. pi's Google adapter rejects a custom fetch,
    // so Google inference rides HTTPS with the gateway token -- but same-account log reads
    // still use the binding.
    const hybridEnv = env({
      CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google,cloudflare",
      WORKERS_AI: fakeBinding,
    });

    const googleHandle = getModel(hybridEnv, {
      provider: "google",
      model: "gemini-2.5-flash",
      apiToken: "ignored-in-gateway-mode",
    }, INITIATOR);
    expect(googleHandle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/" +
        "google-ai-studio/v1beta");
    expect(googleHandle.aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });

    const anthropicHandle = getModel(hybridEnv, ANTHROPIC_CONFIG, INITIATOR);
    const entry = await captureEntry(anthropicHandle);
    expect(entry.url).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic/v1/messages");
    // The binding arm carries the sentinel, never the real gateway token.
    expect(entry.headers["cf-aig-authorization"]).toBe("Bearer cloudflare-gateway-binding");
  }, 15000);

  it("requires the token when google is an enabled provider", () => {
    expect(() => getModel(
        bindingEnv({ CF_AI_GATEWAY_PROVIDERS: "anthropic,google" }),
        ANTHROPIC_CONFIG, INITIATOR)).toThrow(
        "enabling the google provider requires CF_AI_GATEWAY_API_TOKEN");
  });

  it("rejects a stored google config when the deployment has no token", () => {
    expect(() => getModel(bindingEnv(), {
      provider: "google",
      model: "gemini-2.5-flash",
      apiToken: "ignored-in-gateway-mode",
    }, INITIATOR)).toThrow(
        'Provider "google" cannot use the Workers AI binding transport');
  });

});

describe("getModel direct routing (no gateway)", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("uses the provider defaults and the config's own credentials", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiToken: "direct-api-token",
    }, INITIATOR);

    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.baseUrl).toBe("https://api.anthropic.com");
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("direct-api-token");
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
  }, 15000);

  it("uses the config's own account and token for direct Workers AI", async () => {
    // Outside gateway mode, Workers AI is BYOK like any other provider: credentials come from
    // the model config (never from env, which only configures gateway mode).
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      ...WORKERS_AI_CONFIG,
      accountId: "user-account-id",
      apiToken: "user-token",
    }, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe(
        "https://api.cloudflare.com/client/v4/accounts/user-account-id/ai/v1");
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/user-account-id/ai/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer user-token");
  }, 15000);

  it.each([
    { accountId: undefined, apiToken: "user-token" },
    { accountId: "user-account-id", apiToken: "" },
  ])("requires config credentials for direct Workers AI", (overrides) => {
    // Pre-BYOK configs (saved when Workers AI needed no credentials) fail with a clear message.
    expect(() => getModel(env({ CF_AI_GATEWAY: undefined }),
        { ...WORKERS_AI_CONFIG, ...overrides }, INITIATOR))
        .toThrow("This Workers AI model has no Cloudflare credentials.");
  });

  it("appends /v1 to an Ollama server base URL", () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "",
      apiUrl: "http://my-ollama:11434/",
    }, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe("http://my-ollama:11434/v1");
  });

  it("sends no Authorization header for an Ollama config without an API key", async () => {
    // An empty token means local auth: a strict local proxy may reject an unexpected bearer
    // token, so no Authorization header is sent at all (matching the pre-pi provider).
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "",
      apiUrl: "http://my-ollama:11434",
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.url).toBe("http://my-ollama:11434/v1/chat/completions");
    expect(request.headers.get("authorization")).toBeNull();
  }, 15000);

  it("sends the configured Ollama API key as a bearer token", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "ollama-token",
      apiUrl: "http://my-ollama:11434",
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBe("Bearer ollama-token");
  }, 15000);

  it("strips a legacy /api (or /v1) suffix from an Ollama base URL", () => {
    // Configs saved before the pi migration store the native-API base (".../api").
    for (const apiUrl of ["http://my-ollama:11434/api", "http://my-ollama:11434/v1/"]) {
      const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
        provider: "ollama",
        model: "qwen3:8b",
        apiToken: "",
        apiUrl,
      }, INITIATOR);
      expect(handle.model.baseUrl).toBe("http://my-ollama:11434/v1");
    }
  });
});

describe("PDF attachment bridging", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  // PDFs ride pi ImageContent parts (pi has no document part); every handle's onPayload hook
  // rewrites them into the provider's native document blocks (see chat-attachment-pdf.ts).
  // These tests drive the real pi adapters and assert on the outgoing request body.
  const PDF_PART = { type: "image" as const, data: "JVBERi0=", mimeType: "application/pdf" };
  const PNG_PART = { type: "image" as const, data: "iVBOR", mimeType: "image/png" };

  async function capturePdfRequest(handle: ModelHandle): Promise<unknown> {
    const stream = handle.stream(handle.model, {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Summarize the attached PDF." }, PDF_PART, PNG_PART],
        timestamp: 0,
      }],
    }, { fetch: fetchStub, maxRetries: 0 });
    const message = await stream.result();
    expect(message.stopReason).toBe("error");
    return JSON.parse(capturedRequests[0].body);
  }

  it("sends Anthropic PDFs as document blocks", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR);
    const body = await capturePdfRequest(handle) as
        { messages: { content: { type: string; source?: { media_type: string } }[] }[] };

    const blocks = body.messages[0].content;
    expect(blocks).toContainEqual(expect.objectContaining({
      type: "document",
      source: expect.objectContaining({ media_type: "application/pdf", data: "JVBERi0=" }),
    }));
    // A real image in the same message stays an image block.
    expect(blocks).toContainEqual(expect.objectContaining({
      type: "image",
      source: expect.objectContaining({ media_type: "image/png" }),
    }));
    expect(blocks.some((block) => block.source?.media_type === "application/pdf" &&
        block.type !== "document")).toBe(false);
  }, 15000);

  it("sends OpenAI PDFs as input_file parts", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "openai",
      model: "gpt-5.2",
      apiToken: "direct-api-token",
    }, INITIATOR);
    expect(handle.model.api).toBe("openai-responses");
    const body = await capturePdfRequest(handle) as
        { input: { role?: string; content: { type: string; image_url?: string }[] }[] };

    const parts = body.input.find((item) => item.role === "user")!.content;
    expect(parts).toContainEqual({
      type: "input_file",
      filename: "attachment.pdf",
      file_data: "data:application/pdf;base64,JVBERi0=",
    });
    expect(parts).toContainEqual(expect.objectContaining({
      type: "input_image",
      image_url: "data:image/png;base64,iVBOR",
    }));
  }, 15000);
});


describe("explicit OpenAI billing selection", () => {
  beforeEach(() => { capturedRequests.length = 0; });

  it("uses the API key even with both platform and user gateways configured", async () => {
    const handle = getModel(env(), { provider: "openai", model: "gpt-5.6-sol",
      authMode: "apiKey", apiToken: "explicit-api-key" }, INITIATOR,
      { userGateway: { accountId: "user-account", apiKey: "gateway-secret" } });
    const request = await captureRequest(handle);
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.get("authorization")).toBe("Bearer explicit-api-key");
    expect(request.headers.has("cf-aig-authorization")).toBe(false);
    expect(handle.aiGatewayLogRoute).toBeUndefined();
  });

  it("uses the ChatGPT Codex endpoint and never falls back to API billing", async () => {
    const token = `header.${btoa(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "subscription-account" },
    }))}.signature`;
    const handle = getModel(env(), { provider: "openai", model: "gpt-5.6-sol",
      authMode: "chatgpt", apiToken: "", chatgptUserId: "owner-do" }, INITIATOR,
      { ...userRouting(token), userGateway: { accountId: "user-account", apiKey: "gateway-secret" } });
    const request = await captureRequest(handle);
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request.headers.get("chatgpt-account-id")).toBe("subscription-account");
    expect(request.headers.has("cf-aig-authorization")).toBe(false);
    expect(handle.aiGatewayLogRoute).toBeUndefined();
    expect(handle.model.cost.input).toBe(0);
    expect(capturedRequests).toHaveLength(1);
  });

  it("rejects unsupported subscription models without falling back", () => {
    expect(() => getModel(env(), { provider: "openai", model: "unsupported-model",
      authMode: "chatgpt", apiToken: "token" }, INITIATOR)).toThrow("unavailable through ChatGPT");
  });
});


it("rechecks ChatGPT credentials for each inference request, including a long-lived binding", async () => {
  const token = (account: string) => `header.${btoa(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  }))}.signature`;
  const currentToken = vi.fn().mockResolvedValueOnce(token("first-account"))
    .mockResolvedValueOnce(token("second-account"))
    .mockRejectedValueOnce(new Error("Sign in with ChatGPT first."));
  const users = { idFromString: (id: string) => id, get: () => ({ getChatgptAccessToken: currentToken }) };
  const handle = getModel(env(), { provider: "openai", model: "gpt-5.6-sol",
    authMode: "chatgpt", apiToken: "", chatgptUserId: "owner-do" }, INITIATOR,
    { users: users as unknown as NonNullable<Parameters<typeof getModel>[3]>["users"] });
  capturedRequests.length = 0;
  vi.stubGlobal("fetch", fetchStub);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const stream = handle.stream(handle.model, { messages: [
        { role: "user", content: "hello", timestamp: 0 },
      ] }, { maxRetries: 0 });
      expect((await stream.result()).stopReason).toBe("error");
    }
    expect(currentToken).toHaveBeenCalledTimes(3);
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0].headers.get("chatgpt-account-id")).toBe("first-account");
    expect(capturedRequests[1].headers.get("authorization")).toBe(`Bearer ${token("second-account")}`);
  } finally { vi.unstubAllGlobals(); }
});


it("does not reserve platform quota for an explicitly user-funded model", async () => {
  const reserve = vi.fn(async () => { throw new Error("platform budget exhausted"); });
  const guard = { reserve, settle: vi.fn(async () => {}) };
  for (const authMode of ["apiKey", "chatgpt"] as const) {
    const token = `header.${btoa(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account" },
    }))}.signature`;
    const handle = getModel(env(), { provider: "openai", model: "gpt-5.6-sol", authMode,
      apiToken: authMode === "apiKey" ? "key" : "", chatgptUserId: "owner-do" }, INITIATOR,
      { ...userRouting(token), aiRequestGuard: guard });
    await captureRequest(handle);
  }
  expect(reserve).not.toHaveBeenCalled();
});

it("refuses ChatGPT credential snapshots without a user-scoped connection", () => {
  expect(() => getModel(env(), { provider: "openai", model: "gpt-5.6-sol",
    authMode: "chatgpt", apiToken: "stale-token" }, INITIATOR)).toThrow("user-scoped");
});

it("does not retry a ChatGPT HTTP request behind a resolved credential", async () => {
  const token = `header.${btoa(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  }))}.signature`;
  const request = vi.fn(async () => new Response(null, { status: 503 }));
  const handle = getModel(env(), { provider: "openai", model: "gpt-5.6-sol",
    authMode: "chatgpt", apiToken: "", chatgptUserId: "owner-do" }, INITIATOR, userRouting(token));
  const stream = handle.stream(handle.model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { fetch: request, maxRetries: 1 });
  expect((await stream.result()).stopReason).toBe("error");
  expect(request).toHaveBeenCalledTimes(1);
});

it("streams a successful Codex SSE response using current user credentials", async () => {
  const token = `header.${btoa(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  }))}.signature`;
  const item = { id: "msg_test", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Ready", annotations: [] }] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "Ready" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
  ];
  const handle = getModel(env(), { provider: "openai", model: "gpt-5.6-sol", authMode: "chatgpt",
    apiToken: "", chatgptUserId: "owner-do" }, INITIATOR, userRouting(token));
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(req.headers.get("authorization")).toBe(`Bearer ${token}`);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } });
  });
  const stream = handle.stream(handle.model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { fetch: request });
  const received = [];
  for await (const event of stream) received.push(event.type);
  const result = await stream.result();
  expect(received).toContain("text_delta");
  expect(received.at(-1)).toBe("done");
  expect(result.stopReason).toBe("stop");
  expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Ready" }));
  expect(result.usage.totalTokens).toBe(12);
  expect(result.usage.cost.total).toBe(0);
  expect(request).toHaveBeenCalledTimes(1);
});
