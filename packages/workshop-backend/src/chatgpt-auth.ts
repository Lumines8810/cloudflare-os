import type { ChatgptDeviceLogin } from "@gadgets/workshop-shared/api";

// Matches the device flow in the pinned pi-ai Codex adapter. Never accepts an issuer,
// callback URL, device secret or refresh token from the browser.
const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
type Credentials = { access: string; refresh: string; expiresAt: number };
type Pending = ChatgptDeviceLogin & { deviceAuthId: string; nextPollAt: number };
export type ChatgptState = { id: string; credentials?: Credentials; pending?: Pending };

async function request(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${ISSUER}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "manual",
  });
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("ChatGPT returned an invalid authentication response.");
  }
  return data as Record<string, unknown>;
}

async function readCredentials(response: Response, oldRefresh?: string): Promise<Credentials> {
  if (!response.ok) throw new Error(`ChatGPT authentication failed (${response.status}). Please sign in again.`);
  const data = await readObject(response);
  const refresh = data.refresh_token ?? oldRefresh;
  if (typeof data.access_token !== "string" || !data.access_token ||
      typeof refresh !== "string" || !refresh ||
      typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new Error("ChatGPT returned incomplete credentials. Please sign in again.");
  }
  return { access: data.access_token, refresh, expiresAt: Date.now() + data.expires_in * 1000 };
}

/** Per-user persisted credentials. Only public device instructions may cross the browser RPC. */
export class ChatgptConnection {
  #refresh?: Promise<string>;
  constructor(private read: () => ChatgptState | null, private save: (state: ChatgptState | null) => void) {}

  connected(): boolean { return !!this.read()?.credentials; }
  disconnect(): void { this.save(null); }

  async start(): Promise<ChatgptDeviceLogin> {
    // Reserve the attempt before awaiting; cancellation or another start invalidates this request.
    const id = crypto.randomUUID();
    this.save({ id });
    const response = await request("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });
    if (!response.ok) throw new Error(`ChatGPT sign-in could not start (${response.status}). Check that device code login is enabled in your ChatGPT security settings.`);
    const data = await readObject(response);
    const interval = Number(data.interval);
    if (typeof data.device_auth_id !== "string" || !data.device_auth_id ||
        typeof data.user_code !== "string" || !data.user_code ||
        !Number.isFinite(interval) || interval < 0 || interval > 300) {
      throw new Error("ChatGPT returned invalid device authorization instructions.");
    }
    const login: ChatgptDeviceLogin = {
      loginId: id, userCode: data.user_code, verificationUri: `${ISSUER}/codex/device`,
      intervalMs: Math.max(5000, interval * 1000), expiresAt: Date.now() + 15 * 60 * 1000,
    };
    if (this.read()?.id !== id) throw new Error("ChatGPT sign-in was cancelled.");
    this.save({ id, pending: { ...login, deviceAuthId: data.device_auth_id, nextPollAt: Date.now() + login.intervalMs } });
    return login;
  }

  async poll(loginId: string): Promise<boolean> {
    const state = this.read();
    if (!state || state.id !== loginId) throw new Error("ChatGPT sign-in was cancelled. Start again.");
    if (state.credentials) return true;
    const pending = state.pending;
    if (!pending || Date.now() >= pending.expiresAt) throw new Error("ChatGPT sign-in expired. Start again.");
    if (Date.now() < pending.nextPollAt) return false;
    // Reserve the next slot before the fetch to prevent concurrent polls and token exchanges.
    this.save({ ...state, pending: { ...pending, nextPollAt: Date.now() + 60000 } });
    const response = await request("/api/accounts/deviceauth/token", {
      device_auth_id: pending.deviceAuthId, user_code: pending.userCode,
    });
    if (this.read()?.id !== loginId) throw new Error("ChatGPT sign-in was cancelled.");
    if (response.status === 403 || response.status === 404) {
      this.save({ ...state, pending: { ...pending, nextPollAt: Date.now() + pending.intervalMs } });
      return false;
    }
    if (!response.ok) {
      // Only inspect the machine code, never expose provider bodies (which can contain secrets).
      const data = await readObject(response);
      const code = typeof data.error === "object" && data.error !== null
        ? (data.error as Record<string, unknown>).code : data.error;
      if (code === "deviceauth_authorization_pending") {
        this.save({ ...state, pending: { ...pending, nextPollAt: Date.now() + pending.intervalMs } });
        return false;
      }
      if (code === "slow_down") {
        this.save({ ...state, pending: { ...pending, intervalMs: pending.intervalMs + 5000,
          nextPollAt: Date.now() + pending.intervalMs + 5000 } });
        return false;
      }
      throw new Error(`ChatGPT sign-in failed (${response.status}). Start again.`);
    }
    const data = await readObject(response);
    if (typeof data.authorization_code !== "string" || typeof data.code_verifier !== "string") {
      throw new Error("ChatGPT returned an invalid authorization grant.");
    }
    const credentials = await readCredentials(await request("/oauth/token", {
      grant_type: "authorization_code", client_id: CLIENT_ID,
      code: data.authorization_code, code_verifier: data.code_verifier,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
    }));
    if (this.read()?.id !== loginId) throw new Error("ChatGPT sign-in was cancelled.");
    this.save({ id: loginId, credentials });
    return true;
  }

  /** Internal only: resolves a usable access token, serializing refresh-token rotation. */
  async accessToken(): Promise<string> {
    const state = this.read();
    if (!state?.credentials) throw new Error("Sign in with ChatGPT in AI providers first.");
    if (state.credentials.expiresAt > Date.now() + 60000) return state.credentials.access;
    if (this.#refresh) return this.#refresh;
    const credentials = state.credentials;
    this.#refresh = (async () => {
      const updated = await readCredentials(await request("/oauth/token", {
        grant_type: "refresh_token", refresh_token: credentials.refresh, client_id: CLIENT_ID,
      }), credentials.refresh);
      if (this.read()?.id !== state.id) throw new Error("ChatGPT connection changed. Try again.");
      this.save({ id: state.id, credentials: updated });
      return updated.access;
    })();
    try { return await this.#refresh; } finally { this.#refresh = undefined; }
  }
}
