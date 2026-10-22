/**
 * Layer 3 — OpenCode adapter.
 *
 * Implements the AgentAdapter contract for opencode: local background-service
 * discovery, vscode:// pairing, manual URL+password connect, live follow via
 * the opencode-vsc-bridge server plugin, and explicit prompts.
 *
 * Formatting note: OpenCode renders a file reference as `@path#L1-2` in the
 * prompt and as a `file://` URI with `?start&end` when sent as an attachment.
 * Both are produced here from an EditorSnapshot — Layer 1 never sees them.
 */

import type { EditorSnapshot } from "../../context/snapshot"
import type { AgentAdapter, AgentSession, ConnectedSession, LiveFollowChannel } from "../../connector/types"
import {
  authorizationHeader,
  bridgeCall,
  BridgeUnavailableError,
  displayRef,
  parseConnectQuery,
  parseDirectConnect,
  promptRequest,
  redeemPairingCode,
  type Auth,
} from "./wire"
import {
  listSessions,
  parseServiceInfo,
  registrationFiles,
  serviceStateDir,
} from "./discover"

/** Format an EditorSnapshot as OpenCode's `@path#L1-2` chip text. */
export function snapshotRef(snapshot: EditorSnapshot): string {
  return `@${displayRef(snapshot.relativePath, snapshot.selection)}`
}

/** Reads a file as UTF-8, injected so discovery stays unit-testable. */
type ReadFile = (path: string) => Promise<string>
type ReadDir = (path: string) => Promise<string[]>

export function createOpencodeAdapter(io: { readFile: ReadFile; readDir: ReadDir }): AgentAdapter {
  return {
    id: "opencode",
    displayName: "OpenCode",

    async discoverSessions(workspace) {
      void workspace
      const info = await readRegistration(io)
      if (!info) return undefined
      const auth: Auth = info.password ? { type: "basic", password: info.password } : { type: "token", token: "" }
      const server = { url: info.url }
      const sessions = await listSessions(server, auth, { limit: 50 })
      return { url: info.url, header: authorizationHeader(auth), sessions: toAgentSessions(sessions) }
    },

    async connectFromUri(query, workspace) {
      const target = parseConnectQuery(query)
      const { token } = await redeemPairingCode({ url: target.url }, target.code)
      const auth: Auth = { type: "token", token }
      return {
        sessionID: target.sessionID,
        url: target.url,
        header: authorizationHeader(auth),
        directory: workspace,
      }
    },

    connectInteractive() {
      // The interactive flow needs VS Code input boxes, so it is wired up in
      // extension.ts (which owns all UI) rather than inside this adapter.
      return Promise.resolve(undefined)
    },

    liveFollow: createLiveFollow(),

    async sendPrompt(session, snapshot, instruction) {
      const fetchFn = withHeader(session.header)
      const connection = {
        server: { url: session.url },
        auth: { type: "token", token: "" } as const,
        sessionID: session.sessionID,
      }
      await promptRequest(
        connection,
        {
          text: instruction,
          file: { path: snapshot.fsPath, name: snapshot.relativePath, selection: snapshot.selection },
        },
        fetchFn,
      )
    },
  }
}

function createLiveFollow(): LiveFollowChannel {
  return {
    async update(session, snapshot) {
      await bridge(session, "update", snapshot ? snapshotRef(snapshot) : "")
    },
    async pin(session, snapshot) {
      try {
        await bridge(session, "pin", snapshot ? snapshotRef(snapshot) : "")
        return true
      } catch (err) {
        if (err instanceof BridgeUnavailableError) return false
        throw err
      }
    },
    async clear(session) {
      await bridge(session, "clear", "")
    },
  }
}

async function bridge(session: ConnectedSession, method: "update" | "pin" | "clear", text: string) {
  await bridgeCall(
    { url: session.url },
    { type: "token", token: "" },
    method,
    text,
    withHeader(session.header),
    session.directory,
  )
}

/** Force the stored verbatim Authorization header onto every request. */
function withHeader(header: string): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", header)
    return fetch(url, { ...init, headers })
  }) as typeof fetch
}

function toAgentSessions(sessions: Array<{ id: string; title?: string; directory?: string; updatedAt?: number }>): AgentSession[] {
  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    directory: session.directory,
    updatedAt: session.updatedAt,
  }))
}

/** First readable service registration file among the known candidates. */
async function readRegistration(io: { readFile: ReadFile; readDir: ReadDir }) {
  const dir = serviceStateDir()
  let names: string[] = []
  try {
    names = await io.readDir(dir)
  } catch {
    return undefined
  }
  for (const file of registrationFiles(dir, names)) {
    try {
      return parseServiceInfo(await io.readFile(file))
    } catch {
      continue
    }
  }
  return undefined
}

/** Re-export for the manual connect flow (URL + password + session id). */
export function manualConnect(input: { url: string; password?: string; sessionID: string }): Omit<ConnectedSession, "agentId"> {
  const connection = parseDirectConnect(input)
  return {
    sessionID: connection.sessionID,
    url: connection.server.url,
    header: authorizationHeader(connection.auth),
  }
}
