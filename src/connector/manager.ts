/**
 * Layer 2 — connection manager.
 *
 * Owns the single active connection: persisting it (secret header in
 * SecretStorage, the rest in workspaceState), rendering the status bar, and
 * routing Layer-1 editor snapshots to the active adapter's live-follow
 * channel or explicit-prompt method.
 */

import * as vscode from "vscode"
import type { EditorSnapshot } from "../context/snapshot"
import { getAdapter } from "./registry"
import type { ConnectedSession } from "./types"

const SECRET_HEADER = "vscAgents.header"
const STATE_AGENT = "vscAgents.agentId"
const STATE_URL = "vscAgents.url"
const STATE_SESSION = "vscAgents.sessionID"
const STATE_DIRECTORY = "vscAgents.directory"

export class ConnectionManager implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem
  /** Set when the agent's live channel is down; explicit send then falls back. */
  private liveFailed = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.statusBar.command = "vscAgents.connectService"
    context.subscriptions.push(this.statusBar)
  }

  async connect(session: ConnectedSession) {
    await this.context.secrets.store(SECRET_HEADER, session.header)
    await this.context.workspaceState.update(STATE_AGENT, session.agentId)
    await this.context.workspaceState.update(STATE_URL, session.url)
    await this.context.workspaceState.update(STATE_SESSION, session.sessionID)
    await this.context.workspaceState.update(STATE_DIRECTORY, session.directory)
    this.liveFailed = false
    this.render(session)
  }

  async disconnect() {
    await this.context.secrets.delete(SECRET_HEADER)
    await this.context.workspaceState.update(STATE_AGENT, undefined)
    await this.context.workspaceState.update(STATE_URL, undefined)
    await this.context.workspaceState.update(STATE_SESSION, undefined)
    await this.context.workspaceState.update(STATE_DIRECTORY, undefined)
    this.liveFailed = false
    this.render(undefined)
  }

  async current(): Promise<ConnectedSession | undefined> {
    const agentId = this.context.workspaceState.get<string>(STATE_AGENT)
    const url = this.context.workspaceState.get<string>(STATE_URL)
    const sessionID = this.context.workspaceState.get<string>(STATE_SESSION)
    const header = await this.context.secrets.get(SECRET_HEADER)
    if (!agentId || !url || !sessionID || !header) return undefined
    const directory = this.context.workspaceState.get<string>(STATE_DIRECTORY)
    return { agentId, url, sessionID, header, directory }
  }

  /** Live-follow update routed to the active adapter. */
  async liveUpdate(snapshot: EditorSnapshot | undefined) {
    const session = await this.current()
    if (!session) return
    const adapter = getAdapter(session.agentId)
    if (!adapter?.liveFollow) return
    if (this.liveFailed) return
    try {
      if (snapshot) await adapter.liveFollow.update(session, snapshot)
      else await adapter.liveFollow.clear(session)
      this.liveFailed = false
    } catch {
      this.liveFailed = true
    }
  }

  /**
   * Explicit pin. Returns true when the agent handled it through its live
   * channel; false means the caller should fall back to sendPrompt.
   */
  async livePin(snapshot: EditorSnapshot | undefined): Promise<boolean> {
    const session = await this.current()
    if (!session) return false
    const adapter = getAdapter(session.agentId)
    if (!adapter?.liveFollow) return false
    try {
      const ok = await adapter.liveFollow.pin(session, snapshot)
      this.liveFailed = !ok
      return ok
    } catch {
      this.liveFailed = true
      return false
    }
  }

  /** Explicit send of an instruction plus the editor context. */
  async sendPrompt(snapshot: EditorSnapshot, instruction: string) {
    const session = await this.current()
    if (!session) throw new Error("not connected")
    const adapter = getAdapter(session.agentId)
    if (!adapter) throw new Error(`no adapter registered for agent '${session.agentId}'`)
    await adapter.sendPrompt(session, snapshot, instruction)
  }

  render(session: ConnectedSession | undefined) {
    if (session) {
      const name = getAdapter(session.agentId)?.displayName ?? session.agentId
      this.statusBar.text = `$(plug) ${name}: ${short(session.sessionID)}`
      this.statusBar.tooltip = `Connected to ${name} session ${session.sessionID}\n${session.url}\nClick to reconnect`
    } else {
      this.statusBar.text = "$(circle-slash) agent"
      this.statusBar.tooltip = "Not connected to an agent session. Click to connect."
    }
    this.statusBar.show()
  }

  dispose() {
    this.statusBar.dispose()
  }
}

function short(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}
