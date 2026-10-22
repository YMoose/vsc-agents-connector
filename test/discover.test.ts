import assert from "node:assert/strict"
import { test } from "node:test"
import {
  connectionFromService,
  listSessions,
  matchWorkspace,
  parseServiceInfo,
  registrationFiles,
  serviceStateDir,
} from "../src/discover.js"

// ---------------------------------------------------------------------------
// serviceStateDir / registrationFiles
// ---------------------------------------------------------------------------

test("serviceStateDir prefers XDG_STATE_HOME, falls back to ~/.local/state", () => {
  assert.equal(serviceStateDir({ XDG_STATE_HOME: "/xdg" }), "/xdg/opencode")
  assert.equal(serviceStateDir({ HOME: "/home/u" }), "/home/u/.local/state/opencode")
})

test("registrationFiles puts service.json first and sorts channel variants", () => {
  const files = registrationFiles("/dir", ["service-dev.json", "other.json", "service.json", "service-abc.json"])
  assert.deepEqual(files, ["/dir/service.json", "/dir/service-abc.json", "/dir/service-dev.json"])
})

test("registrationFiles works with an empty directory listing", () => {
  assert.deepEqual(registrationFiles("/dir", []), ["/dir/service.json"])
})

// ---------------------------------------------------------------------------
// parseServiceInfo
// ---------------------------------------------------------------------------

test("parseServiceInfo accepts a full registration", () => {
  const info = parseServiceInfo(JSON.stringify({ url: "http://127.0.0.1:4096/", pid: 123, password: "pw", version: "2.1.1" }))
  assert.deepEqual(info, { url: "http://127.0.0.1:4096", pid: 123, password: "pw", version: "2.1.1" })
})

test("parseServiceInfo tolerates a missing password", () => {
  const info = parseServiceInfo(JSON.stringify({ url: "http://h", pid: 1 }))
  assert.equal(info.password, undefined)
})

test("parseServiceInfo rejects garbage", () => {
  assert.throws(() => parseServiceInfo("{}"))
  assert.throws(() => parseServiceInfo(JSON.stringify({ url: "ftp://x", pid: 1 })))
  assert.throws(() => parseServiceInfo(JSON.stringify({ url: "http://h" })))
  assert.throws(() => parseServiceInfo("not json"))
})

test("connectionFromService uses basic auth when a password exists", () => {
  const withPassword = connectionFromService({ url: "http://h", pid: 1, password: "pw" }, "ses_1")
  assert.deepEqual(withPassword.auth, { type: "basic", password: "pw" })
  const without = connectionFromService({ url: "http://h", pid: 1 }, "ses_1")
  assert.deepEqual(without.auth, { type: "token", token: "" })
})

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

function sessionsReply(data: Array<Record<string, unknown>>) {
  return new Response(JSON.stringify({ data, cursor: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("listSessions maps id, title, directory and updated time", async () => {
  const fetchFn = (async (url: string | URL | Request) => {
    assert.match(String(url), /^http:\/\/h\/api\/session\?limit=5$/)
    return sessionsReply([
      {
        id: "ses_1",
        title: "Fix bug",
        location: { directory: "/repo" },
        time: { created: 1, updated: 2 },
      },
      { id: "ses_2", title: "", location: { directory: "/other" } },
    ])
  }) as typeof fetch

  const sessions = await listSessions({ url: "http://h" }, { type: "token", token: "t" }, { limit: 5 }, fetchFn)
  assert.deepEqual(sessions, [
    { id: "ses_1", title: "Fix bug", directory: "/repo", updatedAt: 2 },
    { id: "ses_2", title: undefined, directory: "/other", updatedAt: undefined },
  ])
})

test("listSessions sends the authorization header and directory filter", async () => {
  const seen: { url: string; auth: string | null }[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
    return sessionsReply([])
  }) as typeof fetch
  await listSessions({ url: "http://h" }, { type: "basic", password: "pw" }, { directory: "/repo" }, fetchFn)
  assert.match(seen[0].url, /directory=%2Frepo/)
  assert.equal(seen[0].auth, `Basic ${Buffer.from("opencode:pw").toString("base64")}`)
})

// ---------------------------------------------------------------------------
// matchWorkspace
// ---------------------------------------------------------------------------

test("matchWorkspace prefers an exact directory match", () => {
  const sessions = [
    { id: "ses_1", directory: "/repo/sub" },
    { id: "ses_2", directory: "/repo" },
  ]
  assert.equal(matchWorkspace(sessions, "/repo/")?.id, "ses_2")
})

test("matchWorkspace falls back to a containing directory", () => {
  const sessions = [{ id: "ses_1", directory: "/repo" }]
  assert.equal(matchWorkspace(sessions, "/repo/packages/app")?.id, "ses_1")
})

test("matchWorkspace returns undefined without any overlap", () => {
  assert.equal(matchWorkspace([{ id: "ses_1", directory: "/repo" }], "/elsewhere"), undefined)
  assert.equal(matchWorkspace([{ id: "ses_1" }], "/repo"), undefined)
})
