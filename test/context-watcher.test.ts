import assert from 'node:assert/strict'
import { test } from 'node:test'
import Module from 'node:module'
import type { EditorSnapshot } from '../src/context/snapshot.js'

let text = 'one\n'
const document = { isUntitled: false, uri: { scheme: 'file', fsPath: '/work/a.ts' },
  offsetAt: (position: { line: number; character: number }) => position.line * 4 + position.character,
  getText: () => text,
}
const editor = { document, selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }
let changedText = (_event: { document: typeof document }) => {}
let changedConfig = (_event: { affectsConfiguration: (key: string) => boolean }) => {}
const disposable = { dispose() {} }
const api = {
  window: { activeTextEditor: editor, onDidChangeTextEditorSelection: () => disposable, onDidChangeActiveTextEditor: () => disposable },
  workspace: {
    asRelativePath: () => 'a.ts', getWorkspaceFolder: () => ({ uri: { fsPath: '/work' } }),
    onDidChangeTextDocument: (handler: typeof changedText) => { changedText = handler; return disposable },
    onDidChangeConfiguration: (handler: typeof changedConfig) => { changedConfig = handler; return disposable },
  },
}
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
const original = loader._load
loader._load = function (name, ...args) { return name === 'vscode' ? api : original.call(this, name, ...args) }
const { ContextWatcher } = require('../src/context/watcher.js') as typeof import('../src/context/watcher.js')
loader._load = original

test('watcher captures exclusive end lines, unsaved edits, disable clearing and immediate reconnect', { timeout: 2000 }, async t => {
  let enabled = true
  let resolve: (snapshot: EditorSnapshot | undefined) => void = () => {}
  const next = () => new Promise<EditorSnapshot | undefined>(done => { resolve = done })
  const watcher = new ContextWatcher(snapshot => resolve(snapshot), { debounceMs: () => 0, enabled: () => enabled })
  t.after(() => watcher.dispose())
  let pending = next()
  watcher.start()
  assert.deepEqual((await pending)?.selection, { start: 1, end: 1, text: 'one\n' })
  pending = next()
  text = 'two\n'
  changedText({ document })
  assert.equal((await pending)?.selection?.text, 'two\n')
  pending = next()
  enabled = false
  changedConfig({ affectsConfiguration: () => true })
  assert.equal(await pending, undefined)
  pending = next()
  enabled = true
  watcher.reset()
  assert.equal((await pending)?.fsPath, '/work/a.ts')
})
