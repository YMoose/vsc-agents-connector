import * as vscode from "vscode"
import {
  connectionFromService,
  listSessions,
  matchWorkspace,
  parseServiceInfo,
  registrationFiles,
  serviceStateDir,
} from "./discover"
import {
  ApiError,
  authorizationHeader,
  bridgeCall,
  BridgeUnavailableError,
  displayRef,
  parseConnectQuery,
  parseDirectConnect,
  promptRequest,
  redeemPairingCode,
  type BridgeMethod,
  type Connection,
  type SelectionRange,
} from "./wire"

const SECRET_TOKEN = "vscAgents.token"
const STATE_URL = "vscAgents.url"
const STATE_SESSION = "vscAgents.sessionID"
const STATE_DIRECTORY = "vscAgents.directory"

let statusBar: vscode.StatusBarItem | undefined
let follower: LiveFollower | undefined

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = "vscAgents.connect"
  context.subscriptions.push(statusBar)

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => connectFromUri(context, uri),
    }),
    vscode.commands.registerCommand("vscAgents.connect", () => connectInteractive(context)),
    vscode.commands.registerCommand("vscAgents.connectService", () => connectFromService(context)),
    vscode.commands.registerCommand("vscAgents.disconnect", () => disconnect(context)),
    vscode.commands.registerCommand("vscAgents.sendSelection", () => send(context, "selection")),
    vscode.commands.registerCommand("vscAgents.sendFile", () => send(context, "file")),
  )

  follower = new LiveFollower(context)
  context.subscriptions.push(follower)
  follower.start()

  void refreshStatus(context)
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

async function connectFromUri(context: vscode.ExtensionContext, uri: vscode.Uri) {
  if (uri.path !== "/connect" && uri.path !== "connect") return
  try {
    const target = parseConnectQuery(new URLSearchParams(uri.query))
    const { token } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Connecting to opencode…" },
      () => redeemPairingCode({ url: target.url }, target.code),
    )
    await persist(context, {
      server: { url: target.url },
      auth: { type: "token", token },
      sessionID: target.sessionID,
    }, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
    vscode.window.showInformationMessage(`OpenCode: connected to session ${target.sessionID}.`)
  } catch (err) {
    vscode.window.showErrorMessage(`OpenCode connect failed: ${message(err)}`)
  }
}

/** Manual fallback: paste server URL, password, and session id by hand. */
async function connectInteractive(context: vscode.ExtensionContext) {
  const url = await vscode.window.showInputBox({
    title: "Connect to opencode (1/3)",
    prompt: "Server URL, e.g. http://127.0.0.1:4096",
    ignoreFocusOut: true,
  })
  if (!url) return
  const password = await vscode.window.showInputBox({
    title: "Connect to opencode (2/3)",
    prompt: "Server password (leave empty if the server has none)",
    password: true,
    ignoreFocusOut: true,
  })
  if (password === undefined) return
  const sessionID = await vscode.window.showInputBox({
    title: "Connect to opencode (3/3)",
    prompt: "Session id",
    ignoreFocusOut: true,
  })
  if (!sessionID) return
  try {
    await persist(context, parseDirectConnect({ url, password: password || undefined, sessionID }), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
    vscode.window.showInformationMessage(`OpenCode: connected to session ${sessionID}.`)
  } catch (err) {
    vscode.window.showErrorMessage(`OpenCode connect failed: ${message(err)}`)
  }
}

/**
 * Zero-config path: discover the local opencode background service through its
 * registration file, list its sessions, and let the user pick one. A session
 * whose directory matches the workspace is pre-selected.
 */
async function connectFromService(context: vscode.ExtensionContext) {
  try {
    const info = await readRegistration()
    if (!info) {
      const pick = await vscode.window.showInformationMessage(
        "OpenCode: no background service found (looked for service.json in the XDG state dir). Start `opencode serve --service` or connect manually.",
        "Connect manually…",
      )
      if (pick) await connectInteractive(context)
      return
    }

    const probe = connectionFromService(info, "probe")
    const sessions = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "OpenCode: listing sessions…" },
      () => listSessions(probe.server, probe.auth, { limit: 50 }),
    )
    if (sessions.length === 0) {
      vscode.window.showInformationMessage("OpenCode: the service has no sessions yet.")
      return
    }

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const preferred = workspace ? matchWorkspace(sessions, workspace) : undefined
    const items = sessions.map((session) => ({
      label: session.title || session.id,
      description: session.id === preferred?.id ? `$(check) ${session.id}` : session.id,
      detail: session.directory,
      session,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      title: "Connect to opencode session",
      placeHolder: preferred ? "The session matching this workspace is checked" : "Pick a session",
    })
    if (!picked) return

    await persist(context, connectionFromService(info, picked.session.id), picked.session.directory)
    vscode.window.showInformationMessage(`OpenCode: connected to ${picked.label}.`)
  } catch (err) {
    vscode.window.showErrorMessage(`OpenCode service discovery failed: ${message(err)}`)
  }
}

/** First readable registration file among the known candidates. */
async function readRegistration() {
  const dir = serviceStateDir()
  let names: string[] = []
  try {
    names = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))).map(([name]) => name)
  } catch {
    return undefined
  }
  for (const file of registrationFiles(dir, names)) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file))
      return parseServiceInfo(Buffer.from(bytes).toString("utf8"))
    } catch {
      continue
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Connection persistence
//
// The authorization header (Basic or Bearer, already rendered) is the only
// secret; it lives in SecretStorage. URL and session id are not secrets and
// live in workspaceState so a connection is per-workspace.
// ---------------------------------------------------------------------------

type SavedConnection = {
  url: string
  sessionID: string
  /** Rendered `Authorization` header value. */
  header: string
  /** Server location directory of the connected session — scopes bridge events. */
  directory?: string
}

async function persist(context: vscode.ExtensionContext, connection: Connection, directory?: string) {
  await context.secrets.store(SECRET_TOKEN, authorizationHeader(connection.auth))
  await context.workspaceState.update(STATE_URL, connection.server.url)
  await context.workspaceState.update(STATE_SESSION, connection.sessionID)
  await context.workspaceState.update(STATE_DIRECTORY, directory)
  follower?.reset()
  await refreshStatus(context)
}

async function disconnect(context: vscode.ExtensionContext) {
  await context.secrets.delete(SECRET_TOKEN)
  await context.workspaceState.update(STATE_URL, undefined)
  await context.workspaceState.update(STATE_SESSION, undefined)
  await context.workspaceState.update(STATE_DIRECTORY, undefined)
  await refreshStatus(context)
  vscode.window.showInformationMessage("OpenCode: disconnected.")
}

async function refreshStatus(context: vscode.ExtensionContext) {
  const saved = await restore(context)
  if (!statusBar) return
  if (saved) {
    statusBar.text = `$(plug) opencode: ${short(saved.sessionID)}`
    statusBar.tooltip = `Connected to opencode session ${saved.sessionID}\n${saved.url}\nClick to reconnect`
  } else {
    statusBar.text = "$(circle-slash) opencode"
    statusBar.tooltip = "Not connected to an opencode session. Click to connect."
  }
  statusBar.show()
}

async function restore(context: vscode.ExtensionContext): Promise<SavedConnection | undefined> {
  const url = context.workspaceState.get<string>(STATE_URL)
  const sessionID = context.workspaceState.get<string>(STATE_SESSION)
  const header = await context.secrets.get(SECRET_TOKEN)
  if (!url || !sessionID || !header) return undefined
  const directory = context.workspaceState.get<string>(STATE_DIRECTORY)
  return { url, sessionID, header, directory }
}

function short(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}

// ---------------------------------------------------------------------------
// Sending context
// ---------------------------------------------------------------------------

async function send(context: vscode.ExtensionContext, mode: "selection" | "file") {
  const saved = await restore(context)
  if (!saved) {
    const pick = await vscode.window.showInformationMessage(
      "OpenCode: not connected to a session.",
      "Connect…",
    )
    if (pick) await connectInteractive(context)
    return
  }

  const editor = vscode.window.activeTextEditor
  if (!editor) return
  const document = editor.document
  if (document.isUntitled) {
    vscode.window.showWarningMessage("OpenCode: the active editor has no file on disk.")
    return
  }

  // Preferred path: pin the live chip in the TUI through the bridge plugin —
  // no popup, the user's selection is already mirrored there.
  if (follower && (await follower.pin(saved))) {
    vscode.window.setStatusBarMessage(`OpenCode: pinned ${currentRef(editor)} in the TUI`, 3000)
    return
  }

  // Fallback: the bridge plugin is absent — queue a real prompt instead.
  const relative = vscode.workspace.asRelativePath(document.uri, false)
  const selection = toSelection(editor.selection, mode)
  const instruction = await vscode.window.showInputBox({
    title: "Send to opencode",
    prompt: "What should opencode do with this context?",
    placeHolder: "e.g. explain this function",
    value: mode === "selection" ? "Explain this code" : "Review this file",
    ignoreFocusOut: true,
  })
  if (instruction === undefined) return

  try {
    await promptWithHeader(saved, {
      text: instruction,
      file: { path: document.uri.fsPath, name: relative, selection },
    })
    vscode.window.showInformationMessage(
      `OpenCode: sent ${relative}${selection ? ` (lines ${selection.start}-${selection.end})` : ""}.`,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const pick = await vscode.window.showErrorMessage("OpenCode: credential rejected.", "Reconnect…")
      if (pick) await connectInteractive(context)
      return
    }
    vscode.window.showErrorMessage(`OpenCode send failed: ${message(err)}`)
  }
}

/**
 * The stored header travels verbatim; `wire.promptRequest` renders its own
 * from an `Auth`, so we wrap fetch to force the stored value onto the request.
 */
async function promptWithHeader(saved: SavedConnection, input: Parameters<typeof promptRequest>[1]) {
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", saved.header)
    return fetch(url, { ...init, headers })
  }) as typeof fetch
  const auth = { type: "token", token: "" } as const
  return promptRequest({ server: { url: saved.url }, auth, sessionID: saved.sessionID }, input, fetchFn)
}

function toSelection(selection: vscode.Selection, mode: "selection" | "file"): SelectionRange | undefined {
  if (mode === "file" || selection.isEmpty) return undefined
  return { start: selection.start.line + 1, end: selection.end.line + 1 }
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Live follow
//
// Mirrors the current editor file/selection into the connected opencode TUI
// prompt through the bridge plugin. Debounced; silent when the plugin or a
// connection is absent (the explicit-send path then falls back to prompts).
// ---------------------------------------------------------------------------

class LiveFollower implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined
  private last = ""
  private failed = false
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly context: vscode.ExtensionContext) {}

  start() {
    const push = () => this.schedule()
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(push),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vscAgents.liveFollow")) this.schedule(0)
      }),
    )
    this.schedule(0)
  }

  private enabled() {
    return vscode.workspace.getConfiguration("vscAgents").get<boolean>("liveFollow", true)
  }

  private debounceMs() {
    return vscode.workspace.getConfiguration("vscAgents").get<number>("followDebounceMs", 150)
  }

  private schedule(delay = this.debounceMs()) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.push(), delay)
  }

  private async push() {
    if (!this.enabled() || this.failed) return
    const saved = await restore(this.context)
    if (!saved) return
    const editor = vscode.window.activeTextEditor
    const text = editor && !editor.document.isUntitled ? currentRef(editor) : ""
    if (text === this.last) return
    const ok = await this.call(saved, "update", text)
    if (ok) this.last = text
  }

  /** Explicit pin: commit the current chip in the TUI. Returns false when the bridge is down. */
  async pin(saved: SavedConnection): Promise<boolean> {
    const editor = vscode.window.activeTextEditor
    const text = editor && !editor.document.isUntitled ? currentRef(editor) : ""
    return this.call(saved, "pin", text)
  }

  private async call(saved: SavedConnection, method: BridgeMethod, text: string): Promise<boolean> {
    try {
      await bridgeWithHeader(saved, method, text)
      this.failed = false
      return true
    } catch (err) {
      if (err instanceof BridgeUnavailableError) {
        this.failed = true // stop pushing until reconnect; explicit send falls back
        return false
      }
      // Transient errors (offline server): keep trying on the next change.
      return false
    }
  }

  reset() {
    this.failed = false
    this.last = ""
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    for (const disposable of this.disposables) disposable.dispose()
  }
}

/** `@relative/path#Lx-y` for the editor's current state (no selection → bare path). */
function currentRef(editor: vscode.TextEditor): string {
  const relative = vscode.workspace.asRelativePath(editor.document.uri, false)
  const selection = editor.selection.isEmpty
    ? undefined
    : { start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 }
  return `@${displayRef(relative, selection)}`
}

/** bridgeCall with the stored verbatim authorization header (see promptWithHeader). */
async function bridgeWithHeader(saved: SavedConnection, method: BridgeMethod, text: string) {
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", saved.header)
    return fetch(url, { ...init, headers })
  }) as typeof fetch
  return bridgeCall({ url: saved.url }, { type: "token", token: "" }, method, text, fetchFn, saved.directory)
}
