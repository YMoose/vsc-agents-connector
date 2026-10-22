/**
 * Pure wire-protocol functions for talking to an opencode server.
 *
 * Everything here is dependency-free (no `vscode` import) so the rules can be
 * unit-tested under plain `node --test`. The VS Code-facing adapter lives in
 * `client.ts`; parsing of inbound `vscode://` URIs lives in `connect.ts`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerTarget = {
  /** Base URL of the opencode server, e.g. `http://127.0.0.1:4096`. */
  url: string
}

export type Auth =
  | { type: "basic"; password: string }
  | { type: "token"; token: string }

export type Connection = {
  server: ServerTarget
  auth: Auth
  sessionID: string
}

export type SelectionRange = {
  /** 1-based, inclusive. */
  start: number
  /** 1-based, inclusive. */
  end: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`opencode server answered ${status}: ${body.slice(0, 200)}`)
    this.name = "ApiError"
  }
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingError"
  }
}

// ---------------------------------------------------------------------------
// Auth header
// ---------------------------------------------------------------------------

const PAIRING_USER = "opencode"

export function authorizationHeader(auth: Auth): string {
  if (auth.type === "token") return `Bearer ${auth.token}`
  return `Basic ${base64(`${PAIRING_USER}:${auth.password}`)}`
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64")
}

// ---------------------------------------------------------------------------
// Pairing link parsing
// ---------------------------------------------------------------------------

/**
 * Parse the query of an inbound `vscode://<publisher>.<name>/connect?...` URI.
 *
 * Expected params: `url` (server base URL), `code` (single-use pairing code),
 * `session` (target session id).
 */
export function parseConnectQuery(query: URLSearchParams): { url: string; code: string; sessionID: string } {
  const url = query.get("url") ?? ""
  const code = query.get("code") ?? ""
  const sessionID = query.get("session") ?? ""
  if (!/^https?:\/\//.test(url)) throw new PairingError(`connect link has an invalid server url: ${url || "(missing)"}`)
  if (!code) throw new PairingError("connect link is missing the pairing code")
  if (!sessionID) throw new PairingError("connect link is missing the session id")
  return { url: url.replace(/\/+$/, ""), code, sessionID }
}

/**
 * Direct-connect parameters for servers without pairing (or for testing):
 * a server URL, its password, and a session id.
 */
export function parseDirectConnect(input: {
  url: string
  password?: string
  sessionID: string
}): Connection {
  const url = input.url.replace(/\/+$/, "")
  if (!/^https?:\/\//.test(url)) throw new PairingError(`invalid server url: ${input.url || "(missing)"}`)
  if (!input.sessionID) throw new PairingError("a session id is required")
  return {
    server: { url },
    auth: input.password ? { type: "basic", password: input.password } : { type: "token", token: "" },
    sessionID: input.sessionID,
  }
}

// ---------------------------------------------------------------------------
// Pairing redeem
// ---------------------------------------------------------------------------

type RedeemReply = { token?: string }

/**
 * Exchange a single-use pairing code for a session token.
 *
 * Tries, in order:
 *  1. `GET <url>/auth/connect/<code>?accept=json` — the pairing endpoint; a JSON
 *     `{ token }` body is returned by servers that answer API-style.
 *  2. Any `opencode_session_*` cookie set by a redirect-free reply.
 *  3. `POST <url>/api/pair/redeem` — reserved for older builds.
 */
export async function redeemPairingCode(
  server: ServerTarget,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ token: string }> {
  const response = await fetchFn(`${server.url}/auth/connect/${encodeURIComponent(code)}?accept=json`, {
    redirect: "manual",
  })
  const token = await tokenFromPairingReply(response)
  if (token) return { token }

  // Fallback: some builds expose a JSON redeem endpoint instead.
  const retry = await fetchFn(`${server.url}/api/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  if (retry.ok) {
    const body = (await retry.json()) as RedeemReply
    if (typeof body.token === "string" && body.token) return { token: body.token }
  }
  throw new PairingError(`pairing code was not accepted (server answered ${response.status})`)
}

async function tokenFromPairingReply(response: Response): Promise<string | undefined> {
  const cookie = sessionCookie(response.headers)
  if (cookie) return cookie
  if (!response.ok) return undefined
  const type = response.headers.get("content-type") ?? ""
  if (!type.includes("json")) return undefined
  const body = (await response.json()) as RedeemReply
  return typeof body.token === "string" && body.token ? body.token : undefined
}

function sessionCookie(headers: Headers): string | undefined {
  const all = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""]
  for (const line of all) {
    const pair = line.split(";")[0]
    const eq = pair.indexOf("=")
    if (eq < 0) continue
    if (pair.slice(0, eq).trim().startsWith("opencode_session_")) return pair.slice(eq + 1).trim()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// File reference building
// ---------------------------------------------------------------------------

/** Convert an absolute path to the `file://` URI form prompts carry. */
export function fileUri(path: string, selection?: SelectionRange): string {
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const suffix = selection ? `?start=${selection.start}&end=${selection.end}` : ""
  return `file://${encoded}${suffix}`
}

/** Human chip label: `path#L37-42`, `path#L37`, or bare `path`. */
export function displayRef(relativePath: string, selection?: SelectionRange): string {
  if (!selection) return relativePath
  if (selection.start === selection.end) return `${relativePath}#L${selection.start}`
  return `${relativePath}#L${selection.start}-${selection.end}`
}

/** Metadata other opencode clients decode to re-render the prompt with chips. */
export function fileMetadata(displayText: string) {
  return { displayText }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export type PromptInput = {
  text: string
  file?: { path: string; name?: string; selection?: SelectionRange }
  /** Delivery mode: `queue` waits for an idle boundary, `steer` steers. */
  delivery?: "steer" | "queue"
}

/** POST /api/session/:sessionID/prompt — queue a context message into the session. */
export async function promptRequest(
  connection: Connection,
  input: PromptInput,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const ref = input.file ? displayRef(input.file.name ?? input.file.path, input.file.selection) : undefined
  const displayText = ref ? `${input.text} @${ref}`.trim() : input.text
  const response = await fetchFn(
    `${connection.server.url}/api/session/${encodeURIComponent(connection.sessionID)}/prompt`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorizationHeader(connection.auth),
      },
      body: JSON.stringify({
        text: input.text,
        files: input.file
          ? [{ uri: fileUri(input.file.path, input.file.selection), name: input.file.name }]
          : undefined,
        metadata: fileMetadata(displayText),
        delivery: input.delivery ?? "queue",
      }),
    },
  )
  if (!response.ok) throw new ApiError(response.status, await response.text())
}

/** GET /api/info — health probe; also verifies the credential is accepted. */
export async function probe(connection: Omit<Connection, "sessionID">, fetchFn: typeof fetch = fetch) {
  const response = await fetchFn(`${connection.server.url}/api/info`, {
    headers: { authorization: authorizationHeader(connection.auth) },
  })
  if (!response.ok) throw new ApiError(response.status, await response.text())
  return (await response.json()) as { version?: string }
}

// ---------------------------------------------------------------------------
// Plugin RPC (opencode-vsc-bridge live follow)
// ---------------------------------------------------------------------------

export type BridgeMethod = "update" | "pin" | "clear"

/** The bridge plugin is absent (or the server predates plugin RPC). */
export class BridgeUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`opencode-vsc-bridge is not reachable (server answered ${status})`)
    this.name = "BridgeUnavailableError"
  }
}

/**
 * POST /api/rpc/opencode-vsc-bridge/<method> — push a live chip update to the
 * TUI through the bridge plugin. Throws BridgeUnavailableError when the plugin
 * is not registered, so callers can fall back to the prompt flow.
 *
 * `directory` scopes the emitted event to a server location so only TUIs
 * attached to that directory render the chip (defaults to the service's cwd).
 */
export async function bridgeCall(
  server: { url: string },
  auth: Auth,
  method: BridgeMethod,
  text: string,
  fetchFn: typeof fetch = fetch,
  directory?: string,
): Promise<void> {
  const query = directory ? `?location[directory]=${encodeURIComponent(directory)}` : ""
  const response = await fetchFn(`${server.url}/api/rpc/opencode-vsc-bridge/${method}${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authorizationHeader(auth),
    },
    body: JSON.stringify({ input: { text } }),
  })
  if (!response.ok) throw new BridgeUnavailableError(response.status)
}
