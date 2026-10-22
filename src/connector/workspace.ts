/**
 * Layer 2 — agent-agnostic workspace matching.
 *
 * Picks the session whose working directory best matches the VS Code
 * workspace folder, so the connect QuickPick can pre-select it. Moved out of
 * the opencode discovery module because the rule is not agent-specific.
 */

import type { AgentSession } from "./types"

export function matchWorkspace<T extends AgentSession>(sessions: ReadonlyArray<T>, workspacePath: string): T | undefined {
  const normalized = workspacePath.replace(/\/+$/, "")
  const exact = sessions.find((session) => session.directory?.replace(/\/+$/, "") === normalized)
  if (exact) return exact
  return sessions.find((session) => {
    const directory = session.directory?.replace(/\/+$/, "")
    return directory && (normalized.startsWith(`${directory}/`) || directory.startsWith(`${normalized}/`))
  })
}
