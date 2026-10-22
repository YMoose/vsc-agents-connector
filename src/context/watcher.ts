/**
 * Layer 1 — read and watch VS Code editor context.
 *
 * This module is the only place that talks to `vscode.window` /
 * `vscode.workspace` to learn what the user is looking at. It knows nothing
 * about agents, sessions, or reference formatting.
 */

import * as vscode from "vscode"
import type { EditorSnapshot, SelectionRange } from "./snapshot"

/** Snapshot of the active editor, or undefined when there is none on disk. */
export function readEditorSnapshot(mode: "selection" | "file" = "selection"): EditorSnapshot | undefined {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.isUntitled) return undefined
  const document = editor.document
  return {
    fsPath: document.uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    workspaceFolder: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
    selection: toRange(editor.selection, mode),
  }
}

function toRange(selection: vscode.Selection, mode: "selection" | "file"): SelectionRange | undefined {
  if (mode === "file" || selection.isEmpty) return undefined
  return { start: selection.start.line + 1, end: selection.end.line + 1 }
}

export type ContextChange = (snapshot: EditorSnapshot | undefined) => void

/**
 * Watches selection / active-editor / configuration changes and fires
 * `onChange` with a debounced, deduplicated snapshot. A change fires with
 * `undefined` when the editor has no file on disk (agents clear their chip).
 */
export class ContextWatcher implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined
  private lastKey = ""
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly onChange: ContextChange,
    private readonly options: { debounceMs: () => number; enabled: () => boolean },
  ) {}

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

  private schedule(delay = this.options.debounceMs()) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.emit(), delay)
  }

  private emit() {
    if (!this.options.enabled()) return
    const snapshot = readEditorSnapshot("selection")
    const key = snapshotKey(snapshot)
    if (key === this.lastKey) return
    this.lastKey = key
    this.onChange(snapshot)
  }

  /** Force a re-emit on the next event (e.g. after reconnecting). */
  reset() {
    this.lastKey = ""
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    for (const disposable of this.disposables) disposable.dispose()
  }
}

/** Stable identity used to deduplicate consecutive identical snapshots. */
export function snapshotKey(snapshot: EditorSnapshot | undefined): string {
  if (!snapshot) return ""
  const sel = snapshot.selection
  return `${snapshot.fsPath}#${sel ? `${sel.start}-${sel.end}` : ""}`
}
