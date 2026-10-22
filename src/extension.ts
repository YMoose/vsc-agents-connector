/**
 * Extension entry — assembles the three layers.
 *
 *   Layer 1  src/context/    reads & watches the VS Code editor
 *   Layer 2  src/connector/  connection registry, persistence, dispatch
 *   Layer 3  src/agents/     per-agent implementations (opencode today)
 *
 * This file owns every piece of VS Code UI (input boxes, QuickPicks,
 * messages) and wires Layer 1's editor snapshots through Layer 2 to the
 * active agent. It contains no agent protocol details.
 */

import * as vscode from "vscode"
import { readEditorSnapshot, ContextWatcher } from "./context/watcher"
import { ConnectionManager } from "./connector/manager"
import { allAdapters, getAdapter, registerAdapter } from "./connector/registry"
import { matchWorkspace } from "./connector/workspace"
import type { AgentAdapter } from "./connector/types"
import { createOpencodeAdapter, manualConnect } from "./agents/opencode"

let manager: ConnectionManager | undefined
let watcher: ContextWatcher | undefined

export function activate(context: vscode.ExtensionContext) {
  registerAdapter(
    createOpencodeAdapter({
      readFile: async (path) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path))).toString("utf8"),
      readDir: async (path) => (await vscode.workspace.fs.readDirectory(vscode.Uri.file(path))).map(([name]) => name),
    }),
  )

  manager = new ConnectionManager(context)
  context.subscriptions.push(manager)

  watcher = new ContextWatcher(
    (snapshot) => void manager?.liveUpdate(snapshot),
    {
      debounceMs: () => vscode.workspace.getConfiguration("vscAgents").get<number>("followDebounceMs", 150),
      enabled: () => vscode.workspace.getConfiguration("vscAgents").get<boolean>("liveFollow", true),
    },
  )
  context.subscriptions.push(watcher)
  watcher.start()

  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: (uri) => connectFromUri(uri) }),
    vscode.commands.registerCommand("vscAgents.connect", () => connectInteractive()),
    vscode.commands.registerCommand("vscAgents.connectService", () => connectFromService()),
    vscode.commands.registerCommand("vscAgents.disconnect", () => disconnect()),
    vscode.commands.registerCommand("vscAgents.sendSelection", () => send("selection")),
    vscode.commands.registerCommand("vscAgents.sendFile", () => send("file")),
  )

  void manager.current().then((session) => manager?.render(session))
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Connecting (UI flows; protocol lives in each adapter)
// ---------------------------------------------------------------------------

function workspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

async function connectFromUri(uri: vscode.Uri) {
  if (uri.path !== "/connect" && uri.path !== "connect") return
  const query = new URLSearchParams(uri.query)
  const adapter = pickAdapterForUri(query) ?? allAdapters()[0]
  if (!adapter?.connectFromUri) {
    vscode.window.showErrorMessage("VSC Agents: no agent accepts a connect link.")
    return
  }
  try {
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${adapter.displayName}…` },
      () => adapter.connectFromUri!(query, workspacePath()),
    )
    await manager?.connect({ ...session, agentId: adapter.id })
    watcher?.reset()
    vscode.window.showInformationMessage(`${adapter.displayName}: connected to session ${session.sessionID}.`)
  } catch (err) {
    vscode.window.showErrorMessage(`${adapter.displayName} connect failed: ${message(err)}`)
  }
}

/** A connect link may name its agent via `agent=<id>`; default to opencode. */
function pickAdapterForUri(query: URLSearchParams): AgentAdapter | undefined {
  const id = query.get("agent")
  return id ? getAdapter(id) : getAdapter("opencode")
}

/** Zero-config: ask every adapter to discover local sessions, pick one. */
async function connectFromService() {
  const candidates: Array<{ adapter: AgentAdapter; url: string; header: string; sessions: import("./connector/types").AgentSession[] }> = []
  for (const adapter of allAdapters()) {
    if (!adapter.discoverSessions) continue
    try {
      const found = await adapter.discoverSessions(workspacePath())
      if (found && found.sessions.length > 0) candidates.push({ adapter, ...found })
    } catch (err) {
      console.warn(`vsc-agents: discovery for ${adapter.id} failed`, err)
    }
  }

  if (candidates.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      "VSC Agents: no local agent sessions found. Start your agent's service or connect manually.",
      "Connect manually…",
    )
    if (pick) await connectInteractive()
    return
  }

  const workspace = workspacePath()
  const items = candidates.flatMap(({ adapter, url, header, sessions }) =>
    sessions.map((session) => ({
      label: `[${adapter.displayName}] ${session.title || session.id}`,
      description: session.id,
      detail: session.directory,
      adapter,
      url,
      header,
      session,
    })),
  )
  const all = items.map((item) => item.session)
  const preferred = workspace ? matchWorkspace(all, workspace) : undefined

  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({
      ...item,
      label: item.session.id === preferred?.id ? `$(check) ${item.label}` : item.label,
    })),
    { title: "Connect to an agent session", placeHolder: preferred ? "The session matching this workspace is checked" : "Pick a session" },
  )
  if (!picked) return

  await manager?.connect({
    agentId: picked.adapter.id,
    sessionID: picked.session.id,
    url: picked.url,
    header: picked.header,
    directory: picked.session.directory,
  })
  watcher?.reset()
  vscode.window.showInformationMessage(`${picked.adapter.displayName}: connected to ${picked.session.title || picked.session.id}.`)
}

/** Manual fallback: pick an agent, then enter URL + password + session id. */
async function connectInteractive() {
  const adapter = await pickAdapter()
  if (!adapter) return

  const url = await vscode.window.showInputBox({
    title: `Connect to ${adapter.displayName} (1/3)`,
    prompt: "Server URL, e.g. http://127.0.0.1:4096",
    ignoreFocusOut: true,
  })
  if (!url) return
  const password = await vscode.window.showInputBox({
    title: `Connect to ${adapter.displayName} (2/3)`,
    prompt: "Server password (leave empty if the server has none)",
    password: true,
    ignoreFocusOut: true,
  })
  if (password === undefined) return
  const sessionID = await vscode.window.showInputBox({
    title: `Connect to ${adapter.displayName} (3/3)`,
    prompt: "Session id",
    ignoreFocusOut: true,
  })
  if (!sessionID) return

  try {
    const base = manualConnect({ url, password: password || undefined, sessionID })
    await manager?.connect({ ...base, agentId: adapter.id, directory: workspacePath() })
    watcher?.reset()
    vscode.window.showInformationMessage(`${adapter.displayName}: connected to session ${sessionID}.`)
  } catch (err) {
    vscode.window.showErrorMessage(`${adapter.displayName} connect failed: ${message(err)}`)
  }
}

async function pickAdapter(): Promise<AgentAdapter | undefined> {
  const adapters = allAdapters()
  if (adapters.length === 1) return adapters[0]
  const picked = await vscode.window.showQuickPick(
    adapters.map((adapter) => ({ label: adapter.displayName, adapter })),
    { title: "Connect to an agent", placeHolder: "Pick an agent" },
  )
  return picked?.adapter
}

async function disconnect() {
  const session = await manager?.current()
  await manager?.disconnect()
  watcher?.reset()
  const name = session ? (getAdapter(session.agentId)?.displayName ?? session.agentId) : "agent"
  vscode.window.showInformationMessage(`VSC Agents: disconnected from ${name}.`)
}

// ---------------------------------------------------------------------------
// Sending context
// ---------------------------------------------------------------------------

async function send(mode: "selection" | "file") {
  const session = await manager?.current()
  if (!session) {
    const pick = await vscode.window.showInformationMessage("VSC Agents: not connected to a session.", "Connect…")
    if (pick) await connectFromService()
    return
  }

  const snapshot = readEditorSnapshot(mode)
  if (!snapshot) {
    vscode.window.showWarningMessage("VSC Agents: the active editor has no file on disk.")
    return
  }

  // Preferred path: pin the live chip through the agent's live channel.
  if (await manager?.livePin(snapshot)) {
    const name = getAdapter(session.agentId)?.displayName ?? session.agentId
    vscode.window.setStatusBarMessage(`${name}: pinned ${snapshot.relativePath} in the prompt`, 3000)
    return
  }

  // Fallback: the live channel is unavailable — queue a real prompt instead.
  const instruction = await vscode.window.showInputBox({
    title: "Send to agent",
    prompt: "What should the agent do with this context?",
    placeHolder: "e.g. explain this function",
    value: mode === "selection" ? "Explain this code" : "Review this file",
    ignoreFocusOut: true,
  })
  if (instruction === undefined) return

  try {
    await manager?.sendPrompt(snapshot, instruction)
    vscode.window.showInformationMessage(
      `VSC Agents: sent ${snapshot.relativePath}${snapshot.selection ? ` (lines ${snapshot.selection.start}-${snapshot.selection.end})` : ""}.`,
    )
  } catch (err) {
    vscode.window.showErrorMessage(`VSC Agents send failed: ${message(err)}`)
  }
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
