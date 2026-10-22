/**
 * Layer 1 — editor context snapshot.
 *
 * The data the VS Code side collects about the active editor, in a form that
 * is independent of any agent's reference syntax. Each agent (Layer 3)
 * formats a snapshot into whatever its protocol expects (`@path#L1-2`,
 * `path:1-2`, a structured JSON payload, …).
 */

/** 1-based, inclusive line range. */
export type SelectionRange = {
  start: number
  end: number
}

/** A point-in-time view of the editor the user is working in. */
export type EditorSnapshot = {
  /** Absolute path on disk. */
  fsPath: string
  /** Path relative to the workspace folder (what chips usually show). */
  relativePath: string
  /** Workspace folder the file belongs to, when known. */
  workspaceFolder?: string
  /** Current selection; absent when the cursor has no range or mode is file. */
  selection?: SelectionRange
}
