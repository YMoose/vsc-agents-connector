/**
 * Layer 2 — the contract between the connection/dispatch layer and each
 * agent's concrete implementation (Layer 3).
 *
 * An AgentAdapter owns everything that is specific to one agent: how to
 * discover its sessions, how to connect, how to deliver live-follow context
 * and explicit prompts, and how to format an EditorSnapshot for its protocol.
 */

import type { EditorSnapshot } from "../context/snapshot"

/** A session offered by an agent, shown in the connect QuickPick. */
export type AgentSession = {
  id: string
  title?: string
  directory?: string
  updatedAt?: number
}

/** A persisted, connected session for one agent. */
export type ConnectedSession = {
  /** Which agent this connection belongs to. */
  agentId: string
  sessionID: string
  url: string
  /** Rendered `Authorization` header value (stored in SecretStorage). */
  header: string
  /** The session's working directory; scopes location-tagged events. */
  directory?: string
}

/** Live-follow channel an agent may support (optional capability). */
export type LiveFollowChannel = {
  /** Editor context changed; replace the agent's live chip. */
  update(session: ConnectedSession, snapshot: EditorSnapshot | undefined): Promise<void>
  /**
   * Explicit pin: commit the live chip. Returns false when the agent's live
   * channel is unavailable so the caller can fall back to sendPrompt.
   */
  pin(session: ConnectedSession, snapshot: EditorSnapshot | undefined): Promise<boolean>
  /** Editor lost its file; clear the chip. */
  clear(session: ConnectedSession): Promise<void>
}

export interface AgentAdapter {
  readonly id: string
  readonly displayName: string

  /** Discover locally-running sessions for the connect QuickPick. */
  discoverSessions?(workspace?: string): Promise<{ url: string; header: string; sessions: AgentSession[] } | undefined>

  /** Connect from an inbound vscode://…/connect URI. */
  connectFromUri?(query: URLSearchParams, workspace?: string): Promise<Omit<ConnectedSession, "agentId">>

  /** Manual / interactive connect fallback. */
  connectInteractive?(workspace?: string): Promise<Omit<ConnectedSession, "agentId"> | undefined>

  /** Optional live-follow capability. */
  readonly liveFollow?: LiveFollowChannel

  /** Send an explicit instruction plus the editor context as a prompt. */
  sendPrompt(session: ConnectedSession, snapshot: EditorSnapshot, instruction: string): Promise<void>
}
