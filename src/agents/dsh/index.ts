import { randomUUID } from 'node:crypto'
import type { EditorPlug } from '../../../vendor/dsh-editor-socket/lib/plug.js' with { 'resolution-mode': 'import' }
import type { Registration } from '../../../vendor/dsh-editor-socket/lib/discovery.js' with { 'resolution-mode': 'import' }
import type { EditorSnapshot as WireSnapshot } from '../../../vendor/dsh-editor-socket/lib/protocol.js' with { 'resolution-mode': 'import' }
import type { EditorSnapshot } from '../../context/snapshot'
import type { AgentAdapter, ConnectedSession, DiscoveredSessions } from '../../connector/types'
import { filterByWorkspace } from '../../connector/workspace'

// Native dynamic import preserves the SDK's ESM boundary in this CommonJS extension.
const sdk = () => import('../../../vendor/dsh-editor-socket/lib/plug.js')
const discovery = () => import('../../../vendor/dsh-editor-socket/lib/discovery.js')

export function toDshSnapshot(snapshot: EditorSnapshot, directory: string): WireSnapshot {
  const selection = snapshot.selection
  // Keep paths and line ranges even when the selected buffer exceeds the default text budget.
  const text = selection?.text
  return { path: snapshot.fsPath, workspace: snapshot.workspaceFolder ?? directory,
    ...(selection ? { selection: { start: selection.start, end: selection.end,
      ...(text !== undefined && Buffer.byteLength(text, 'utf8') <= 32_768 ? { text } : {}) } } : {}) }
}

export function createDshAdapter(options: {
  discover?: () => Promise<readonly Registration[]>
  fetch?: typeof fetch
  clientId?: string
} = {}): AgentAdapter {
  const clientId = options.clientId ?? randomUUID()
  let active: { key: string; plug: EditorPlug } | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work)
    tail = result.catch(() => {})
    return result
  }
  const key = (session: ConnectedSession) => `${session.url}|${session.sessionID}|${session.header}`
  const release = async () => {
    const previous = active
    active = undefined
    if (previous) await previous.plug.disconnect().catch(() => {})
  }
  const ensure = async (session: ConnectedSession): Promise<EditorPlug> => {
    if (active?.key === key(session)) {
      if (active.plug.error) throw active.plug.error
      return active.plug
    }
    if (!session.directory) throw new Error('DSH requires a workspace directory')
    await release()
    const { EditorPlug } = await sdk()
    const plug = new EditorPlug({ url: session.url, headers: { authorization: session.header }, fetch: options.fetch, timeoutMs: 30_000 })
    await plug.connect({ sessionId: session.sessionID, clientId, editor: 'VS Code', workspace: session.directory })
    active = { key: key(session), plug }
    return plug
  }
  return {
    id: 'dsh', displayName: 'DSH',
    async discoverSessions(workspace) {
      const registrations = await (options.discover?.() ?? discovery().then(module => module.discoverSockets()))
      const { EditorPlug } = await sdk()
      const found = await Promise.all(registrations.map(async (registration): Promise<DiscoveredSessions | undefined> => {
        const header = `Bearer ${registration.token}`
        // A persisted-session listing can need disk/cache reads after DSH starts.
        const plug = new EditorPlug({ url: registration.url, headers: { authorization: header }, fetch: options.fetch, timeoutMs: 10_000 })
        try {
          const all = await plug.sessions()
          const sessions = workspace ? filterByWorkspace(all.map(session => ({ ...session, id: session.sessionId })), workspace) : all
          return { url: registration.url, header, sessions: sessions.map(session => ({
            id: session.sessionId, title: session.title, directory: session.directory,
          })) }
        } catch { return undefined }
      }))
      return found.filter((group): group is DiscoveredSessions => !!group && group.sessions.length > 0)
    },
    connect: session => serial(async () => { await release(); await ensure(session) }),
    disconnect: () => serial(release),
    liveFollow: {
      update: (session, snapshot) => serial(async () => {
        const plug = await ensure(session)
        if (!snapshot?.workspaceFolder || !filterByWorkspace([{ id: '', directory: snapshot.workspaceFolder }], session.directory!).length) await plug.clear()
        else await plug.update(toDshSnapshot(snapshot, session.directory!))
      }),
      clear: session => serial(async () => { await (await ensure(session)).clear() }),
    },
  }
}
