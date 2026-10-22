import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ApiError,
  authorizationHeader,
  displayRef,
  fileUri,
  parseConnectQuery,
  parseDirectConnect,
  promptRequest,
  redeemPairingCode,
  PairingError,
  type Connection,
} from "../src/agents/opencode/wire.js"

// ---------------------------------------------------------------------------
// authorizationHeader
// ---------------------------------------------------------------------------

test("authorizationHeader renders Basic for passwords", () => {
  assert.equal(
    authorizationHeader({ type: "basic", password: "secret" }),
    `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
  )
})

test("authorizationHeader renders Bearer for tokens", () => {
  assert.equal(authorizationHeader({ type: "token", token: "abc" }), "Bearer abc")
})

// ---------------------------------------------------------------------------
// parseConnectQuery
// ---------------------------------------------------------------------------

test("parseConnectQuery accepts a full link", () => {
  const parsed = parseConnectQuery(new URLSearchParams("url=http://127.0.0.1:4096&code=xyz&session=ses_1"))
  assert.deepEqual(parsed, { url: "http://127.0.0.1:4096", code: "xyz", sessionID: "ses_1" })
})

test("parseConnectQuery strips trailing slashes from the url", () => {
  const parsed = parseConnectQuery(new URLSearchParams("url=http://host:1/&code=c&session=s"))
  assert.equal(parsed.url, "http://host:1")
})

test("parseConnectQuery rejects a missing or non-http url", () => {
  assert.throws(() => parseConnectQuery(new URLSearchParams("code=c&session=s")), PairingError)
  assert.throws(() => parseConnectQuery(new URLSearchParams("url=ftp://x&code=c&session=s")), PairingError)
})

test("parseConnectQuery rejects a missing code or session", () => {
  assert.throws(() => parseConnectQuery(new URLSearchParams("url=http://h&session=s")), PairingError)
  assert.throws(() => parseConnectQuery(new URLSearchParams("url=http://h&code=c")), PairingError)
})

test("parseDirectConnect requires a session id and an http url", () => {
  assert.throws(() => parseDirectConnect({ url: "http://h", sessionID: "" }), PairingError)
  assert.throws(() => parseDirectConnect({ url: "nope", sessionID: "s" }), PairingError)
  const connection = parseDirectConnect({ url: "http://h/", password: "p", sessionID: "s" })
  assert.equal(connection.server.url, "http://h")
  assert.deepEqual(connection.auth, { type: "basic", password: "p" })
})

// ---------------------------------------------------------------------------
// fileUri / displayRef
// ---------------------------------------------------------------------------

test("fileUri encodes segments and appends a line range", () => {
  assert.equal(fileUri("/repo/src/a b.ts", { start: 3, end: 9 }), "file:///repo/src/a%20b.ts?start=3&end=9")
  assert.equal(fileUri("/repo/src/a.ts"), "file:///repo/src/a.ts")
})

test("fileUri keeps the file authority form for relative inputs", () => {
  assert.equal(fileUri("src/a.ts", { start: 1, end: 1 }), "file://src/a.ts?start=1&end=1")
})

test("displayRef formats single-line and multi-line ranges", () => {
  assert.equal(displayRef("src/a.ts", { start: 7, end: 7 }), "src/a.ts#L7")
  assert.equal(displayRef("src/a.ts", { start: 7, end: 9 }), "src/a.ts#L7-9")
  assert.equal(displayRef("src/a.ts"), "src/a.ts")
})

// ---------------------------------------------------------------------------
// redeemPairingCode
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
}

test("redeemPairingCode takes a JSON token when the connect endpoint answers one", async () => {
  const fetchFn = (async (url: string | URL | Request) => {
    assert.match(String(url), /\/auth\/connect\/code-1\?accept=json$/)
    return jsonResponse({ token: "tok-1" })
  }) as typeof fetch
  assert.deepEqual(await redeemPairingCode({ url: "http://h" }, "code-1", fetchFn), { token: "tok-1" })
})

test("redeemPairingCode falls back to an opencode_session_* cookie", async () => {
  const fetchFn = (async () =>
    new Response("<html>paired</html>", {
      status: 200,
      headers: { "set-cookie": "opencode_session_4096=tok-cookie; Path=/; HttpOnly" },
    })) as unknown as typeof fetch
  assert.deepEqual(await redeemPairingCode({ url: "http://h" }, "c", fetchFn), { token: "tok-cookie" })
})

test("redeemPairingCode uses the JSON redeem endpoint when connect answers HTML", async () => {
  const calls: string[] = []
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(String(url))
    if (calls.length === 1) return new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } })
    return jsonResponse({ token: "tok-2" })
  }) as unknown as typeof fetch
  assert.deepEqual(await redeemPairingCode({ url: "http://h" }, "c", fetchFn), { token: "tok-2" })
  assert.match(calls[1], /\/api\/pair\/redeem$/)
})

test("redeemPairingCode fails when no strategy yields a token", async () => {
  const fetchFn = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
  await assert.rejects(() => redeemPairingCode({ url: "http://h" }, "bad", fetchFn), PairingError)
})

// ---------------------------------------------------------------------------
// promptRequest
// ---------------------------------------------------------------------------

const connection: Connection = {
  server: { url: "http://h:1" },
  auth: { type: "basic", password: "pw" },
  sessionID: "ses_9",
}

function capturingFetch(reply: () => Response) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) })
    return reply()
  }) as typeof fetch
  return { calls, fetchFn }
}

test("promptRequest posts text, file uri, metadata and queue delivery", async () => {
  const { calls, fetchFn } = capturingFetch(() => jsonResponse({ data: {} }))
  await promptRequest(
    connection,
    {
      text: "Explain this",
      file: { path: "/repo/src/a.ts", name: "src/a.ts", selection: { start: 2, end: 4 } },
    },
    fetchFn,
  )
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.url, "http://h:1/api/session/ses_9/prompt")
  assert.equal(call.init.method, "POST")
  assert.equal(
    new Headers(call.init.headers).get("authorization"),
    `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
  )
  assert.deepEqual(call.body.files, [{ uri: "file:///repo/src/a.ts?start=2&end=4", name: "src/a.ts" }])
  assert.equal(call.body.delivery, "queue")
  assert.deepEqual(call.body.metadata, { displayText: "Explain this @src/a.ts#L2-4" })
})

test("promptRequest omits files for a bare text prompt", async () => {
  const { calls, fetchFn } = capturingFetch(() => jsonResponse({ data: {} }))
  await promptRequest(connection, { text: "hi" }, fetchFn)
  assert.equal(calls[0].body.files, undefined)
  assert.deepEqual(calls[0].body.metadata, { displayText: "hi" })
})

test("promptRequest throws ApiError with the status on failure", async () => {
  const { fetchFn } = capturingFetch(() => new Response("unauthorized", { status: 401 }))
  const err = await promptRequest(connection, { text: "hi" }, fetchFn).catch((e) => e)
  assert.ok(err instanceof ApiError)
  assert.equal(err.status, 401)
})

// ---------------------------------------------------------------------------
// bridgeCall
// ---------------------------------------------------------------------------

test("bridgeCall posts the chip text to the plugin RPC endpoint", async () => {
  const { bridgeCall } = await import("../src/agents/opencode/wire.js")
  const { calls, fetchFn } = capturingFetch(() => jsonResponse({}))
  await bridgeCall({ url: "http://h:1" }, { type: "token", token: "t" }, "update", "@src/a.ts#L1-2", fetchFn)
  assert.equal(calls[0].url, "http://h:1/api/rpc/opencode-vsc-bridge/update")
  assert.deepEqual(calls[0].body, { input: { text: "@src/a.ts#L1-2" } })
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer t")
})

test("bridgeCall throws BridgeUnavailableError on failure", async () => {
  const { bridgeCall, BridgeUnavailableError } = await import("../src/agents/opencode/wire.js")
  const { fetchFn } = capturingFetch(() => new Response("nope", { status: 404 }))
  const err = await bridgeCall({ url: "http://h" }, { type: "token", token: "" }, "pin", "x", fetchFn).catch(
    (e) => e,
  )
  assert.ok(err instanceof BridgeUnavailableError)
  assert.equal(err.status, 404)
})

test("bridgeCall scopes the event with location[directory] when given", async () => {
  const { bridgeCall } = await import("../src/agents/opencode/wire.js")
  const { calls, fetchFn } = capturingFetch(() => jsonResponse({}))
  await bridgeCall({ url: "http://h:1" }, { type: "token", token: "t" }, "update", "@a.ts", fetchFn, "/work/dir")
  assert.equal(
    calls[0].url,
    "http://h:1/api/rpc/opencode-vsc-bridge/update?location[directory]=%2Fwork%2Fdir",
  )
})
