import assert from 'node:assert/strict'
import { test } from 'node:test'
import Module from 'node:module'
import type { ExtensionContext } from 'vscode'
import type { AgentAdapter, ConnectedSession } from '../src/connector/types.js'
import { registerAdapter } from '../src/connector/registry.js'

// VS Code owns these APIs in production; the test exercises manager scheduling and persistence.
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
const original = loader._load
loader._load = function (name, ...args) {
  if (name === 'vscode') return { window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) }, StatusBarAlignment: { Left: 1 } }
  return original.call(this, name, ...args)
}
const { ConnectionManager } = require('../src/connector/manager.js') as typeof import('../src/connector/manager.js')
loader._load = original

test('connection switching drains old edits, releases its lease, and refuses unsupported prompt fallback', async () => {
  const state = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const context = {
    subscriptions: [],
    workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value) } },
    secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value) }, delete: async (key: string) => { secrets.delete(key) } },
  } as unknown as ExtensionContext
  const order: string[] = []
  const adapter: AgentAdapter = { id: 'lifecycle-test', displayName: 'Test',
    connect: async session => { order.push(`connect:${session.sessionID}`) },
    disconnect: async session => { order.push(`disconnect:${session.sessionID}`) },
    liveFollow: { update: async session => { order.push(`update:${session.sessionID}`) }, pin: async () => true, clear: async () => {} },
  }
  registerAdapter(adapter)
  const manager = new ConnectionManager(context)
  const session: ConnectedSession = { agentId: adapter.id, sessionID: 'first', url: 'http://localhost', header: 'test' }
  await manager.connect(session)
  const snapshot = { fsPath: '/work/a', relativePath: 'a' }
  await Promise.all([manager.liveUpdate(snapshot), manager.connect({ ...session, sessionID: 'second' }), manager.liveUpdate(snapshot)])
  assert.deepEqual(order, ['connect:first', 'update:first', 'disconnect:first', 'connect:second', 'update:second'])
  await assert.rejects(manager.sendPrompt(snapshot, 'do something'), /input area/)
  await manager.shutdown()
  assert.equal(order.at(-1), 'disconnect:second')
  assert.equal((await manager.current())?.sessionID, 'second', 'shutdown retains workspace choice for restore')
  await manager.liveUpdate(snapshot)
  assert.equal(order.at(-1), 'disconnect:second')
})
