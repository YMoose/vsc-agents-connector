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
  if (!editor || editor.document.isUntitled || editor.document.uri.scheme !== 'file') return undefined
  const document = editor.document
  return {
    fsPath: document.uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    workspaceFolder: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
    selection: toRange(editor, mode),
  }
}

function toRange(editor: vscode.TextEditor, mode: "selection" | "file"): SelectionRange | undefined {
  const { selection, document } = editor
  if (mode === "file" || selection.isEmpty) return undefined
  const start = selection.start.line + 1
  const end = selection.end.line + (selection.end.character === 0 && selection.end.line > selection.start.line ? 0 : 1)
  // Bound the buffer read before allocating the selected string.
  const length = document.offsetAt(selection.end) - document.offsetAt(selection.start)
  const text = length <= 32768 ? document.getText(selection) : undefined
  return { start, end, ...(text !== undefined && Buffer.byteLength(text, 'utf8') <= 32768 ? { text } : {}) }
}

export type ContextChange = (snapshot: EditorSnapshot | undefined) => void

/**
 * Watches selection / active-editor / configuration changes and fires
 * `onChange` with a debounced, deduplicated snapshot. A change fires with
 * `undefined` when the editor has no file on disk (agents clear their chip).
 */
export class ContextWatcher implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined
  private lastKey: string | undefined
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
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === vscode.window.activeTextEditor?.document) this.schedule()
      }),
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
    const snapshot = this.options.enabled() ? readEditorSnapshot("selection") : undefined
    const key = snapshotKey(snapshot)
    if (key === this.lastKey) return
    this.lastKey = key
    this.onChange(snapshot)
  }

  /** Force a re-emit on the next event (e.g. after reconnecting). */
  reset() {
    this.lastKey = undefined
    this.schedule(0)
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
  return JSON.stringify([snapshot.fsPath, snapshot.workspaceFolder, sel])
}
