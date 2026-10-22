import assert from "node:assert/strict"
import { test } from "node:test"
import { filterByWorkspace } from "../src/connector/workspace.js"

test("filterByWorkspace keeps only sessions in the exact workspace directory", () => {
  const sessions = [
    { id: "ses_root", directory: "/repo" },
    { id: "ses_sub", directory: "/repo/sub" },
    { id: "ses_other", directory: "/elsewhere" },
  ]
  assert.deepEqual(filterByWorkspace(sessions, "/repo").map((s) => s.id), ["ses_root"])
})

test("filterByWorkspace tolerates a trailing slash on either side", () => {
  const sessions = [{ id: "ses_1", directory: "/repo/" }]
  assert.deepEqual(filterByWorkspace(sessions, "/repo").map((s) => s.id), ["ses_1"])
  assert.deepEqual(filterByWorkspace([{ id: "ses_1", directory: "/repo" }], "/repo/").map((s) => s.id), ["ses_1"])
})

test("filterByWorkspace does not match subdirectory or parent sessions", () => {
  // A session in /repo must not match a workspace in /repo/packages/app, and
  // vice versa: the relative path would resolve against the wrong directory.
  const sessions = [{ id: "ses_1", directory: "/repo" }]
  assert.deepEqual(filterByWorkspace(sessions, "/repo/packages/app"), [])
  const sub = [{ id: "ses_2", directory: "/repo/packages/app" }]
  assert.deepEqual(filterByWorkspace(sub, "/repo"), [])
})

test("filterByWorkspace drops sessions without a directory", () => {
  assert.deepEqual(filterByWorkspace([{ id: "ses_1" }], "/repo"), [])
})
