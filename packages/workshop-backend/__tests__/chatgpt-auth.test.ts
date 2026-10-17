import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatgptConnection, type ChatgptState } from "../src/chatgpt-auth.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function connection(initial: ChatgptState | null = null) {
  let state = initial;
  return { auth: new ChatgptConnection(() => state, value => { state = value; }), read: () => state };
}

describe("ChatGPT device authentication", () => {
  it("keeps device secrets and bearer credentials server-side, and honors polling intervals", async () => {
    let now = 100000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ device_auth_id: "device-secret", user_code: "ABCD-EFGH", interval: "5" }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ authorization_code: "grant", code_verifier: "verifier" }))
      .mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      // Exercise workerd's real Request validation (e.g. its supported redirect modes).
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("content-type")).toBe(String(input).endsWith("/oauth/token")
        ? "application/x-www-form-urlencoded" : "application/json");
      return fetch(input, init);
    });
    const { auth, read } = connection();
    const login = await auth.start();
    expect(login).not.toHaveProperty("deviceAuthId");
    expect(login.verificationUri).toBe("https://auth.openai.com/codex/device");
    expect(await auth.poll(login.loginId)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += login.intervalMs;
    expect(await auth.poll(login.loginId)).toBe(false);
    now += login.intervalMs;
    expect(await auth.poll(login.loginId)).toBe(true);
    expect(auth.connected()).toBe(true);
    expect(await auth.accessToken()).toBe("access");
    expect(read()?.pending).toBeUndefined();
    const exchange = Object.fromEntries(new URLSearchParams(fetch.mock.calls[3][1].body));
    expect(exchange).toMatchObject({ code: "grant", code_verifier: "verifier",
      redirect_uri: "https://auth.openai.com/deviceauth/callback" });
  });

  it("rejects another user's attempt without calling OpenAI", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { auth } = connection();
    await expect(auth.poll("other-user-login")).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serializes refresh-token rotation and saves the rotated token", async () => {
    const { auth, read } = connection({ id: "session", credentials: {
      access: "expired", refresh: "old-refresh+&", expiresAt: 0,
    } });
    const fetch = vi.fn().mockResolvedValue(Response.json({
      access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
    }));
    vi.stubGlobal("fetch", fetch);
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(["new-access", "new-access"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(read()?.credentials?.refresh).toBe("new-refresh");
    const request = fetch.mock.calls[0][1];
    expect(new Headers(request.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(request.body).get("refresh_token")).toBe("old-refresh+&");
  });

  it("does not resurrect a connection disconnected during refresh", async () => {
    const { auth, read } = connection({ id: "session", credentials: {
      access: "expired", refresh: "old-refresh", expiresAt: 0,
    } });
    let respond!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
    const refreshing = auth.accessToken();
    auth.disconnect();
    respond(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
    await expect(refreshing).rejects.toThrow("connection changed");
    expect(read()).toBeNull();
  });

  it("does not disclose provider response bodies on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "must-stay-secret" }, { status: 401 })));
    await expect(connection().auth.start()).rejects.toThrow("could not start (401)");
  });
});

it("cancels only the matching pending login, preserving newer and completed connections", () => {
  const pending = { loginId: "new-attempt", userCode: "public-code", verificationUri: "https://auth.openai.com/codex/device",
    intervalMs: 5000, expiresAt: 900000, deviceAuthId: "device-secret", nextPollAt: 5000 };
  const { auth, read } = connection({ id: "new-attempt", pending });
  auth.cancel("stale-attempt");
  expect(read()?.id).toBe("new-attempt");
  auth.cancel("new-attempt");
  expect(read()).toBeNull();
  const completed = connection({ id: "completed", credentials: { access: "access", refresh: "refresh", expiresAt: 900000 } });
  completed.auth.cancel("completed");
  expect(completed.auth.connected()).toBe(true);
});

it("never exposes malformed authentication response text", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('private-auth-token is not JSON', { status: 200 })));
  await expect(connection().auth.start()).rejects.toThrow("invalid authentication response");
});
