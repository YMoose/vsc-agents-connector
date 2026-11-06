import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshAdapter, toDshSnapshot } from '../src/agents/dsh/index.js'
import type { ConnectedSession } from '../src/connector/types.js'

const session: ConnectedSession = { agentId: 'dsh', sessionID: 's', directory: '/work', url: 'http://127.0.0.1:12345', header: 'Bearer test' }
const snapshot = { fsPath: '/work/a.ts', relativePath: 'a.ts', workspaceFolder: '/work', selection: { start: 1, end: 2, text: 'unsaved' } }
function fixture(listed = [{ sessionId: 's', title: '编辑器上下文接入', directory: '/work', status: 'idle' }]) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const fetchFn: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), session.header)
    assert.equal(init?.redirect, 'error')
    const request = JSON.parse(String(init?.body))
    calls.push(request)
    const value = request.method === 'info' ? { protocolVersion: 2 }
      : request.method === 'sessions' ? listed
      : request.method === 'connect' ? { connectionId: 'lease', heartbeatMs: 10_000, state: { sessionId: 's' } }
      : {}
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
  }
  const adapter = createDshAdapter({ fetch: fetchFn, clientId: 'window', discover: async () => [
    { protocolVersion: 2, instanceId: 'instance', pid: 1234, url: session.url, token: 'test' },
  ] })
  return { adapter, calls }
}

test('DSH discovers matching sessions and serializes editor operations through its standalone SDK', async () => {
  const { adapter, calls } = fixture()
  const found = await adapter.discoverSessions!('/work')
  assert.ok(Array.isArray(found))
  assert.equal(found[0]?.sessions[0]?.id, 's')
  assert.equal(found[0]?.sessions[0]?.title, '编辑器上下文接入')
  assert.deepEqual(await adapter.discoverSessions!('/other'), [])
  await adapter.connect!(session)
  await Promise.all([
    adapter.liveFollow!.update(session, snapshot),
    adapter.liveFollow!.clear(session),
    adapter.disconnect!(session),
  ])
  const mutations = calls.filter(call => ['update', 'clear', 'disconnect'].includes(call.method))
  assert.deepEqual(mutations.map(call => call.method), ['update', 'clear', 'disconnect'])
  assert.deepEqual(mutations.map(call => call.payload.sequence), [1, 2, 3])
  assert.deepEqual(mutations[0]?.payload.snapshot, {
    path: '/work/a.ts', workspace: '/work', selection: { start: 1, end: 2, text: 'unsaved' },
  })
  assert.equal(adapter.liveFollow!.pin, undefined, 'DSH has no pin capability')
  assert.equal(adapter.sendPrompt, undefined, 'editor sync never falls back to a model task')
})

test('switching to another workspace clears DSH live context and a new connection rotates the lease', async () => {
  const { adapter, calls } = fixture()
  await adapter.connect!(session)
  await adapter.liveFollow!.update(session, { ...snapshot, fsPath: '/other/a.ts', workspaceFolder: '/other' })
  assert.equal(calls.at(-1)?.method, 'clear')
  await adapter.liveFollow!.update(session, { ...snapshot, fsPath: '/outside/a.ts', workspaceFolder: undefined })
  assert.equal(calls.at(-1)?.method, 'clear', 'a loose file must not leave the previous live reference behind')
  await adapter.connect!(session)
  assert.deepEqual(calls.slice(-3).map(call => call.method), ['disconnect', 'info', 'connect'])
  await adapter.disconnect!(session)
})

test('large UTF-8 selection text falls back to file and line references', () => {
  const value = toDshSnapshot({ ...snapshot, selection: { start: 3, end: 5, text: '中'.repeat(12_000) } }, '/work')
  assert.deepEqual(value.selection, { start: 3, end: 5 })
})

test('six persisted sessions are offered without connecting; only the selected one is connected', async () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ sessionId: `history-${i}`, title: `历史会话 ${i}`, directory: '/work', status: 'unloaded' }))
  const { adapter, calls } = fixture([...history, { sessionId: 'elsewhere', title: 'Other workspace', directory: '/other', status: 'unloaded' }])
  const found = await adapter.discoverSessions!('/work')
  assert.ok(Array.isArray(found))
  assert.deepEqual(found[0]?.sessions.map(item => item.id), history.map(item => item.sessionId))
  assert.deepEqual(calls.map(call => call.method), ['sessions'])
  await adapter.connect!({ ...session, sessionID: 'history-3' })
  assert.deepEqual(calls.filter(call => call.method === 'connect').map(call => call.payload.sessionId), ['history-3'])
  await adapter.disconnect!({ ...session, sessionID: 'history-3' })
})
