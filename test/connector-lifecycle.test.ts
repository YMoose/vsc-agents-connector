import assert from 'node:assert/strict'
import { test } from 'node:test'
import Module from 'node:module'
import type { ExtensionContext, StatusBarItem } from 'vscode'
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

function createContext(): ExtensionContext {
  const state = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  return {
    subscriptions: [],
    workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value) } },
    secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value) }, delete: async (key: string) => { secrets.delete(key) } },
  } as unknown as ExtensionContext
}

test('connection switching drains old edits, releases its lease, and refuses unsupported prompt fallback', async () => {
  const context = createContext()
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

test('session titles survive restore, refresh on reconnect and clear when switching to an untitled session', async () => {
  const context = createContext()
  const manager = new ConnectionManager(context)
  const bar = context.subscriptions[0] as StatusBarItem
  const session: ConnectedSession = {
    agentId: 'title-test', sessionID: 'session-first', title: '编辑器上下文接入',
    url: 'http://localhost', header: 'test',
  }
  await manager.connect(session)
  assert.equal(bar.text, '$(plug) title-test: 编辑器上下文接入')
  assert.match(String(bar.tooltip), /编辑器上下文接入\nConnected to title-test session session-first/)

  const restored = new ConnectionManager(context)
  assert.equal((await restored.current())?.title, session.title)
  restored.render(await restored.current())
  assert.equal((context.subscriptions[1] as StatusBarItem).text, bar.text)

  const renamed = '重命名后的会话'.repeat(10)
  await manager.connect({ ...session, title: renamed })
  assert.equal((await manager.current())?.title, renamed)
  assert.equal(bar.text, `$(plug) title-test: ${Array.from(renamed).slice(0, 39).join('')}…`)
  assert.ok(String(bar.tooltip).startsWith(`${renamed}\n`), 'hover retains the complete title')

  await manager.connect({ ...session, sessionID: 'second', title: undefined })
  assert.equal((await manager.current())?.title, undefined)
  assert.equal(bar.text, '$(plug) title-test: second', 'untitled sessions fall back to ID')
  await manager.disconnect()
  assert.equal(await manager.current(), undefined)
  assert.equal(context.workspaceState.get('vscAgents.sessionTitle'), undefined)
  manager.dispose()
  restored.dispose()
})

test('follow-only adapters synchronize and clear without requiring a pin capability', async () => {
  const order: string[] = []
  const adapter: AgentAdapter = { id: 'follow-only-test', displayName: 'Follow',
    liveFollow: { update: async () => { order.push('update') }, clear: async () => { order.push('clear') } },
  }
  registerAdapter(adapter)
  const manager = new ConnectionManager(createContext())
  await manager.connect({ agentId: adapter.id, sessionID: 's', url: 'http://localhost', header: 'test' })
  assert.equal(await manager.livePin(undefined), false)
  assert.equal(await manager.liveUpdate({ fsPath: '/work/a', relativePath: 'a' }), true)
  assert.equal(await manager.liveUpdate(undefined), true)
  assert.deepEqual(order, ['update', 'clear'])
  manager.dispose()
})
