# ChatGPT subscription and API key selection

This fork adds two explicit OpenAI connection choices under **AI providers → Add
provider → LLM connection / billing**:

* **Sign in with ChatGPT · subscription** uses the Codex models available to the
  connected ChatGPT account, subject to that plan's model availability and limits.
* **OpenAI API key · usage-based billing** uses an existing API key and its API
  billing account. ChatGPT subscriptions do not pay for API requests.

The existing providers / AI Gateway choice keeps its previous behavior. Explicit
ChatGPT and API key selections bypass both the platform and personal Cloudflare
AI Gateways. There is no automatic fallback between billing methods.

## Connect and switch

1. Choose the ChatGPT connection and press **Sign in with ChatGPT**. Open the
   verification link at `https://auth.openai.com/codex/device`, enter the displayed
   one-time code, and authorize your account. Device code login may need enabling
   in ChatGPT's security settings. The code expires after 15 minutes.
2. Choose a supported model and add it. The model name ends in **ChatGPT
   subscription**.
3. Add the API version separately by choosing **OpenAI API key**, selecting a
   model, and entering your existing key in the sensitive-input field. Its name
   ends in **API key (usage-based)**.
4. Choose either entry in the normal chat model picker. Both entries can use the
   same underlying model without overwriting one another. The normal model
   preference controls which entry is selected next time.

Disconnecting ChatGPT removes its credentials and configured ChatGPT models,
without removing API key models. The next request from an existing ChatGPT agent
or model binding checks the connection again and fails after disconnect.

## Implementation and operating requirements

This is an integration with the **pinned third-party pi-ai Codex adapter**, not a
general-purpose ChatGPT API or an OpenAI-issued OAuth client for this deployment.
Device authorization follows the same public-client Codex protocol used by that
adapter. An eligible account and successful OpenAI authorization are required;
endpoint or policy changes may require an adapter update. Neither ChatGPT website
session cookies nor manually copied bearer tokens are accepted by the UI.

Tokens and device secrets remain in the authenticated user's Durable Object.
Only the one-time user code and fixed verification URL go to the browser. Refresh
tokens are rotated and persisted server-side; inference rechecks credentials on
every request, including long-running agents and model bindings. Concurrent
refreshes share one operation, and cancelled attempts cannot restore credentials.

The Worker needs outbound HTTPS access to `auth.openai.com` (device login and
token refresh), `chatgpt.com` (Codex inference), and `api.openai.com` (API-key
inference), or the explicitly configured API proxy. Local environments with an
outbound allowlist need those destinations enabled through their normal network
configuration workflow.

ChatGPT inference uses SSE and the Codex model's context window for compaction.
Subscription token prices are recorded as zero API cost; that is not a usage
balance or a promise of unlimited service. Cloudflare hosting/storage costs
remain separate. Auxiliary title generation for a selected explicit model uses
the same billing route. Provider errors never switch it to another paid route.

Unit tests use synthetic credentials and mock HTTP responses. A real subscription
sign-in, real API inference, and a deployment smoke test remain necessary before
production rollout. Never put credentials in tracked files or PR descriptions.
