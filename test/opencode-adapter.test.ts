import assert from "node:assert/strict"
import { test } from "node:test"
import { snapshotRef } from "../src/agents/opencode/index.js"
import type { EditorSnapshot } from "../src/context/snapshot.js"

function snapshot(partial: Partial<EditorSnapshot> & Pick<EditorSnapshot, "relativePath">): EditorSnapshot {
  return { fsPath: `/abs/${partial.relativePath}`, ...partial }
}

test("snapshotRef formats a bare file reference", () => {
  assert.equal(snapshotRef(snapshot({ relativePath: "src/a.ts" })), "@src/a.ts")
})

test("snapshotRef formats a single-line selection", () => {
  assert.equal(snapshotRef(snapshot({ relativePath: "src/a.ts", selection: { start: 7, end: 7 } })), "@src/a.ts#L7")
})

test("snapshotRef formats a multi-line selection", () => {
  assert.equal(snapshotRef(snapshot({ relativePath: "src/a.ts", selection: { start: 7, end: 9 } })), "@src/a.ts#L7-9")
})
