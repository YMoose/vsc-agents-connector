/**
 * Layer 2 — registry of available agent adapters.
 *
 * Adapters register themselves here; the connection manager and the connect
 * flows look them up by id. Adding support for a new agent means implementing
 * AgentAdapter under src/agents/<id>/ and registering it once here.
 */

import type { AgentAdapter } from "./types"

const adapters = new Map<string, AgentAdapter>()

export function registerAdapter(adapter: AgentAdapter) {
  adapters.set(adapter.id, adapter)
}

export function getAdapter(id: string): AgentAdapter | undefined {
  return adapters.get(id)
}

export function allAdapters(): AgentAdapter[] {
  return [...adapters.values()]
}
