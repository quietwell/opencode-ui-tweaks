// Pure logic: status, section edits and the arrangement into groups. Run: npx tsx --test test/model.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  addSection,
  arrange,
  assign,
  deleteSection,
  displayTitle,
  folderName,
  initialState,
  isUnread,
  moveSection,
  placeSection,
  RECENT_LIMIT,
  renameSection,
  sessionKey,
  shortAge,
  sinceOf,
  statusOf,
  visibleRows,
  workingSince,
  type Entry,
  type SessionLike,
  type State,
  type Status,
} from "../src/model"

const state = (): State => structuredClone(initialState)

const session = (id: string, time: Partial<SessionLike["time"]> = {}, extra: Partial<SessionLike> = {}): SessionLike => ({
  id,
  title: `Session ${id}`,
  time: { created: 1, updated: 1, ...time },
  location: { directory: "C:\\work\\demo" },
  ...extra,
})

const entry = (id: string, status: Status, time: Partial<SessionLike["time"]> = {}, selected = false): Entry => {
  const value = session(id, time)

  return {
    key: sessionKey("local", id),
    server: "local",
    session: value,
    status,
    since: sinceOf(status, value),
    project: "demo",
    selected,
  }
}

test("unread: the last run ended after the last view", () => {
  assert.equal(isUnread(session("a")), false)
  assert.equal(isUnread(session("a", { idle: 10 })), true)
  assert.equal(isUnread(session("a", { idle: 10, viewed: 5 })), true)
  assert.equal(isUnread(session("a", { idle: 10, viewed: 10 })), false)
})

test("workingSince: only while the current run has not ended", () => {
  assert.equal(workingSince(session("a")), undefined)
  assert.equal(workingSince(session("a", { busy: 5 })), 5)
  assert.equal(workingSince(session("a", { busy: 5, idle: 9 })), undefined)
  assert.equal(workingSince(session("a", { busy: 12, idle: 9 })), 12)
})

test("status: a waiting request beats running, running beats unread", () => {
  const done = session("a", { idle: 10 })

  assert.equal(statusOf({ session: done, permission: true, form: true, busy: true }), "approval")
  assert.equal(statusOf({ session: done, permission: false, form: true, busy: true }), "input")
  assert.equal(statusOf({ session: done, permission: false, form: false, busy: true }), "working")
  assert.equal(statusOf({ session: done, permission: false, form: false, busy: false }), "done")
  assert.equal(
    statusOf({ session: { ...done, outcome: "failed" }, permission: false, form: false, busy: false }),
    "failed",
  )
  assert.equal(
    statusOf({ session: session("a", { idle: 10, viewed: 11 }), permission: false, form: false, busy: false }),
    "ready",
  )
})

test("titles and folders", () => {
  assert.equal(displayTitle(undefined, "New session"), "New session")
  assert.equal(displayTitle("New session - 2026-11-20T10:00:00.000Z", "Neu"), "Neu")
  assert.equal(displayTitle("Fix the build", "Neu"), "Fix the build")
  assert.equal(folderName("C:\\work\\demo"), "demo")
  assert.equal(folderName("/home/me/app/"), "app")
})

test("sections: add, rename, move, delete", () => {
  const draft = state()
  const a = addSection(draft, "  Work  ")!
  const b = addSection(draft, "Private")!

  assert.equal(addSection(draft, "   "), undefined)
  assert.deepEqual(
    draft.sections.map((section) => section.name),
    ["Work", "Private"],
  )

  renameSection(draft, a, "Client   work")
  renameSection(draft, a, "  ")
  assert.equal(draft.sections[0].name, "Client work")

  moveSection(draft, b, -1)
  assert.deepEqual(
    draft.sections.map((section) => section.id),
    [b, a],
  )
  moveSection(draft, b, -1)
  assert.equal(draft.sections[0].id, b, "the first section does not move up")

  assign(draft, "local\ns1", a)
  assign(draft, "local\ns2", b)
  assign(draft, "local\ns3", "missing")
  assert.deepEqual(draft.assigned, { "local\ns1": a, "local\ns2": b })

  deleteSection(draft, a)
  assert.deepEqual(draft.assigned, { "local\ns2": b }, "deleting a section frees its sessions")
  assign(draft, "local\ns2", undefined)
  assert.deepEqual(draft.assigned, {})
})

test("arrange: every session lands in exactly one group", () => {
  const draft = state()
  const work = addSection(draft, "Work")!

  const entries = [
    entry("ask", "approval", { busy: 50 }),
    entry("run", "working", { busy: 40 }),
    entry("run-early", "working", { busy: 20 }),
    entry("sectioned", "ready", { idle: 30, viewed: 31 }),
    entry("sectioned-running", "working", { busy: 60 }),
    entry("sectioned-asking", "input", { busy: 10 }),
    entry("loose-old", "ready", { idle: 5, viewed: 6 }),
    entry("loose-new", "ready", { idle: 25, viewed: 26 }),
    entry("loose-unread", "done", { idle: 8 }),
    entry("gone", "ready", { idle: 9, viewed: 9, archived: 100 }),
    entry("gone-sectioned", "ready", { idle: 9, viewed: 9, archived: 200 }),
  ]

  for (const id of ["sectioned", "sectioned-running", "sectioned-asking", "gone-sectioned"])
    assign(draft, sessionKey("local", id), work)

  const view = arrange(entries, draft)
  const ids = (list: Entry[]) => list.map((item) => item.session.id)

  assert.deepEqual(ids(view.needs), ["sectioned-asking", "ask"], "longest wait first, also for sectioned sessions")
  assert.deepEqual(ids(view.sections[0].rows), ["sectioned", "sectioned-running"], "a running session stays in its section")
  assert.equal(view.sections[0].working, 1)
  assert.deepEqual(
    ids(view.recent.rows),
    ["loose-new", "loose-unread", "loose-old", "run", "run-early"],
    "Recent sorts by when the last run ended; sessions that never finished one sort by creation",
  )
  assert.equal(view.recent.unread, 1)
  assert.equal(view.recent.working, 2)
  assert.deepEqual(ids(view.archived.rows), ["gone-sectioned", "gone"], "latest archived first")

  const all = [...view.needs, ...view.sections[0].rows, ...view.recent.rows, ...view.archived.rows]
  assert.equal(all.length, entries.length)
  assert.equal(new Set(all.map((item) => item.key)).size, entries.length)

  // With the top group turned off, a waiting session stays where it is and its group counts it.
  const inPlace = arrange(entries, { ...draft, attentionOnTop: false })

  assert.deepEqual(ids(inPlace.needs), [])
  assert.ok(ids(inPlace.sections[0].rows).includes("sectioned-asking"))
  assert.equal(inPlace.sections[0].attention, 1)
  assert.equal(inPlace.recent.attention, 1)
})

test("arrange: a session keeps its place while it runs and moves up when the run ends", () => {
  const draft = state()
  const idle = (id: string, at: number) => entry(id, "ready", { idle: at, viewed: at + 1 })
  const ids = (list: Entry[]) => list.map((item) => item.session.id)

  const before = arrange([idle("a", 300), idle("b", 200), idle("c", 100)], draft)

  assert.deepEqual(ids(before.recent.rows), ["a", "b", "c"])

  // `c` starts a run: `time.busy` and `time.updated` move, the end of its last run does not.
  const running = entry("c", "working", { idle: 100, viewed: 101, busy: 400, updated: 450 })
  const during = arrange([idle("a", 300), idle("b", 200), running], draft)

  assert.deepEqual(ids(during.recent.rows), ["a", "b", "c"], "same order while it works")
  assert.equal(during.recent.rows[2].status, "working")

  const after = arrange([idle("a", 300), idle("b", 200), entry("c", "done", { idle: 500, viewed: 101, busy: 400 })], draft)

  assert.deepEqual(ids(after.recent.rows), ["c", "a", "b"], "newest finished first")
})

test("sections: drag one before or after another", () => {
  const draft = state()
  const [a, b, c] = ["A", "B", "C"].map((name) => addSection(draft, name)!)
  const order = () => draft.sections.map((section) => section.name).join("")

  placeSection(draft, c, a, false)
  assert.equal(order(), "CAB")
  placeSection(draft, c, b, true)
  assert.equal(order(), "ABC")
  placeSection(draft, a, b, true)
  assert.equal(order(), "BAC")
  placeSection(draft, a, a, true)
  placeSection(draft, a, "missing", true)
  placeSection(draft, "missing", a, true)
  assert.equal(order(), "BAC", "dropping on itself or an unknown section changes nothing")
})

test("arrange: a session of a deleted section shows in Recent", () => {
  const draft = state()
  const work = addSection(draft, "Work")!

  assign(draft, sessionKey("local", "a"), work)
  draft.sections = []

  const view = arrange([entry("a", "ready", { idle: 1, viewed: 2 })], draft)

  assert.equal(view.recent.rows.length, 1)
})

test("arrange: Recent cuts at the limit, but keeps unread, running and the open session", () => {
  const draft = state()

  const read = Array.from({ length: RECENT_LIMIT + 5 }, (_, at) =>
    entry(`r${at}`, "ready", { idle: 1000 - at, viewed: 2000 }, at === RECENT_LIMIT + 3),
  )

  const old = [entry("u", "done", { idle: 1 }), entry("w", "working", { idle: 2, viewed: 3, busy: 5000 })]
  const view = arrange([...read, ...old], draft)

  assert.equal(view.recent.more, true)
  assert.equal(view.recent.total, RECENT_LIMIT + 7)
  assert.equal(view.recent.rows.length, RECENT_LIMIT + 3, "the limit, the open one, the unread one and the running one")
  assert.deepEqual(
    view.recent.rows.slice(-2).map((item) => item.session.id),
    ["w", "u"],
    "they keep their place at the end",
  )
  assert.ok(view.recent.rows.some((item) => item.selected))

  draft.recentExpanded = true
  assert.equal(arrange([...read, ...old], draft).recent.rows.length, RECENT_LIMIT + 7)
})

test("a collapsed group still shows the open session", () => {
  const rows = [entry("a", "ready"), entry("b", "ready", {}, true)]

  assert.equal(visibleRows(rows, false).length, 2)
  assert.deepEqual(
    visibleRows(rows, true).map((item) => item.session.id),
    ["b"],
  )
})

test("ages", () => {
  const labels = { now: "now" }

  assert.equal(shortAge(undefined, 0, labels), "")
  assert.equal(shortAge(0, 30_000, labels), "now")
  assert.equal(shortAge(0, 30_000, labels, true), "30s")
  assert.equal(shortAge(0, 5 * 60_000, labels), "5m")
  assert.equal(shortAge(0, 3 * 3_600_000, labels), "3h")
  assert.equal(shortAge(0, 2 * 86_400_000, labels), "2d")
})
