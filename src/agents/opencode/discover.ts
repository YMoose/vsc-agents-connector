/**
 * Discovery of the local opencode background service and session listing.
 *
 * Pure, dependency-free (no `vscode` import) so it is unit-testable under
 * `node --test`. The service registration file is the documented discovery
 * contract (`@opencode/client/service`): reading it is all a client needs.
 */

import type { Auth, Connection } from "./wire.js"
import { ApiError, authorizationHeader } from "./wire.js"

// ---------------------------------------------------------------------------
// Service registration file
// ---------------------------------------------------------------------------

export type ServiceInfo = {
  url: string
  pid: number
  password?: string
  version?: string
}

/**
 * Directory holding `service.json` (and channel variants `service-<name>.json`).
 * Follows the XDG state dir convention the opencode CLI uses.
 */
export function serviceStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME
  const home = env.HOME ?? ""
  return xdg ? `${xdg}/opencode` : `${home}/.local/state/opencode`
}

/** Parse and validate a registration file's contents. */
export function parseServiceInfo(raw: string): ServiceInfo {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== "object" || value === null) throw new Error("registration file is not an object")
  const info = value as Record<string, unknown>
  if (typeof info.url !== "string" || !/^https?:\/\//.test(info.url)) {
    throw new Error("registration file has no usable url")
  }
  if (typeof info.pid !== "number") throw new Error("registration file has no pid")
  return {
    url: info.url.replace(/\/+$/, ""),
    pid: info.pid,
    password: typeof info.password === "string" ? info.password : undefined,
    version: typeof info.version === "string" ? info.version : undefined,
  }
}

/** Registration candidates, most standard first. */
export function registrationFiles(dir: string, names: ReadonlyArray<string>): string[] {
  const preferred = ["service.json"]
  const variants = names
    .filter((name) => /^service-.+\.json$/.test(name))
    .sort()
  return [...preferred, ...variants.filter((v) => v !== "service.json")].map((name) => `${dir}/${name}`)
}

/** Connection from a discovered service: basic auth with the service password. */
export function connectionFromService(info: ServiceInfo, sessionID: string): Connection {
  return {
    server: { url: info.url },
    auth: info.password ? { type: "basic", password: info.password } : { type: "token", token: "" },
    sessionID,
  }
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

export type SessionSummary = {
  id: string
  title?: string
  directory?: string
  updatedAt?: number
}

type SessionsReply = {
  data?: Array<Record<string, unknown>>
}

/**
 * GET /api/session — list sessions, newest first.
 *
 * The reply shape is `{ data: Session.Info[] }`; fields beyond id/title are
 * read defensively since the schema evolves.
 */
export async function listSessions(
  server: { url: string },
  auth: Auth,
  options: { directory?: string; limit?: number } = {},
  fetchFn: typeof fetch = fetch,
): Promise<SessionSummary[]> {
  const query = new URLSearchParams()
  if (options.directory) query.set("directory", options.directory)
  if (options.limit) query.set("limit", String(options.limit))
  const suffix = query.size ? `?${query}` : ""
  const response = await fetchFn(`${server.url}/api/session${suffix}`, {
    headers: { authorization: authorizationHeader(auth) },
  })
  if (!response.ok) throw new ApiError(response.status, await response.text())
  const body = (await response.json()) as SessionsReply
  return (body.data ?? []).flatMap((item) => {
    if (typeof item.id !== "string") return []
    return [
      {
        id: item.id,
        title: typeof item.title === "string" && item.title ? item.title : undefined,
        directory: readDirectory(item.location),
        updatedAt: readTime(item.time),
      },
    ]
  })
}

function readDirectory(location: unknown): string | undefined {
  if (typeof location !== "object" || location === null) return undefined
  const directory = (location as Record<string, unknown>).directory
  return typeof directory === "string" ? directory : undefined
}

function readTime(time: unknown): number | undefined {
  if (typeof time !== "object" || time === null) return undefined
  const updated = (time as Record<string, unknown>).updated
  return typeof updated === "number" ? updated : undefined
}
