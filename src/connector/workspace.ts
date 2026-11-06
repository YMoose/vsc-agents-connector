/**
 * Layer 2 — agent-agnostic workspace matching.
 *
 * The connect QuickPick only offers sessions running in the VS Code workspace
 * folder, because the editor context the extension sends is a workspace-relative
 * path (`@src/a.ts#L1-2`). A session rooted anywhere else would resolve that
 * relative path against a different directory, so connecting to it is never
 * useful. Hence matching is exact-directory, not best-effort.
 */

import type { AgentSession } from "./types"
import { posix } from "node:path"

/** Normalize a directory for comparison: strip trailing slashes. */
function normalize(directory: string): string {
  return posix.normalize(directory.replaceAll("\\", "/")).replace(/\/+$/, "").replace(/^[A-Z]:/, drive => drive.toLowerCase())
}

/** Sessions whose directory is exactly the workspace folder. */
export function filterByWorkspace<T extends AgentSession>(sessions: ReadonlyArray<T>, workspacePath: string): T[] {
  const normalized = normalize(workspacePath)
  return sessions.filter((session) => session.directory !== undefined && normalize(session.directory) === normalized)
}

