// Runs the built bundle (dist/gui-experimental.cjs) in jsdom with the browser build of Solid and a stand-in for the
// app: an Inbox sidebar in the DOM, one fake server with sessions, and the parts of the plugin context the bundle uses.
// It checks that the list replaces the app's, and drives sections, menus, running sessions, Archived, the buttons under
// messages and the layout switch. Usage: node test/gui-render.cjs
const Module = require("module")
const path = require("path")
const { JSDOM } = require("jsdom")

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" })
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "Event", "MouseEvent", "KeyboardEvent", "SVGElement", "Text", "DocumentFragment", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]
for (const k of globals) Object.defineProperty(globalThis, k, { value: typeof dom.window[k] === "function" && /Animation|getComputed/.test(k) ? dom.window[k].bind(dom.window) : (dom.window[k] ?? dom.window), configurable: true, writable: true })
globalThis.window = dom.window
// This jsdom has no PointerEvent; the app's Chromium does.
dom.window.PointerEvent ??= class PointerEvent extends dom.window.MouseEvent {
  constructor(type, init = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? ""
  }
}

const solidDir = path.dirname(require.resolve("solid-js/package.json"))
const browser = {
  "solid-js": path.join(solidDir, "dist/solid.cjs"),
  "solid-js/web": path.join(solidDir, "web/dist/web.cjs"),
  "solid-js/store": path.join(solidDir, "store/dist/store.cjs"),
}
const registry = (id) => ({ kind: "registry", id })
const host = {
  Plugin: { define: (d) => d },
  Store: { global: (schema, initial) => ({ scope: "global", schema, initial }) },
  Command: registry("command"),
  SettingsPage: registry("settings"),
  Style: registry("style"),
}
// The bundle only builds its store schema from `effect`; the fake store below ignores it.
const inert = () => new Proxy(function () {}, { get: () => inert(), apply: () => inert() })
const load = Module._load
Module._load = function (req, parent, isMain) {
  if (req === "@opencode/plugin/gui") return host
  if (req === "effect") return { Schema: inert() }
  if (req in browser) return load.call(this, browser[req], parent, isMain)
  return load.apply(this, arguments)
}
const { createRoot, createSignal, createRenderEffect } = require("solid-js")
const { createStore, produce } = require("solid-js/store")
const web = require("solid-js/web")

const def = require(path.resolve(process.argv[2] ?? path.join(__dirname, "../dist/gui-experimental.cjs"))).default
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, label) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label)
  if (!ok) failed = true
}

const NOW = Date.now()
const info = (id, title, time, extra = {}) => ({
  id,
  projectID: "p1",
  title,
  cost: 0,
  tokens: {},
  time: { created: NOW - 9e6, updated: NOW - 6e4, ...time },
  location: { directory: "C:\\work\\demo" },
  ...extra,
})

/** One fake server: the fetched pages, the app's live data and the calls the plugin made. */
function fakeServer() {
  const calls = []
  const pages = {
    active: [
      info("s-ask", "Needs a permission", { busy: NOW - 30_000 }),
      info("s-run", "Still running", { busy: NOW - 20_000 }),
      info("s-done", "Finished, unread", { idle: NOW - 120_000 }),
      info("s-read", "Read already", { idle: NOW - 600_000, viewed: NOW - 500_000 }),
      info("s-gen", "New session - 2026-11-20T10:00:00.000Z", { idle: NOW - 900_000, viewed: NOW - 800_000 }),
    ],
    archived: [info("s-arch", "Old and archived", { idle: NOW - 8e6, viewed: NOW - 7e6, archived: NOW - 5e6 })],
  }
  const [running, setRunning] = createStore({ "s-run": true })
  const [permissions] = createStore({ "s-ask": [{ id: "perm1", sessionID: "s-ask" }] })
  const pendingItems = {}
  // Subagent sessions the live data knows, by their parent.
  const parents = {}
  // The loaded messages of a session, and the message a revert hides from, as the live data holds them.
  const [live, setLive] = createStore({ messages: {}, revert: {} })
  const listeners = new Set()
  const find = (id) => [...pages.active, ...pages.archived].find((s) => s.id === id)
  const emit = (name, data) => listeners.forEach((fn) => fn({ name, details: { type: name, data } }))

  const client = {
    session: {
      list: async (input) => {
        calls.push(["list", input])
        // A real client decodes a fresh object per response.
        return { data: structuredClone(input.archived ? pages.archived : pages.active), cursor: {} }
      },
      update: async (input) => {
        calls.push(["update", input])
        const session = find(input.sessionID)
        if (input.title !== undefined) session.title = input.title
        if (input.archived === true) {
          pages.active = pages.active.filter((s) => s !== session)
          pages.archived = [{ ...session, time: { ...session.time, archived: Date.now() } }, ...pages.archived]
          emit("session.archived", { sessionID: input.sessionID })
        }
        if (input.archived === false) {
          pages.archived = pages.archived.filter((s) => s !== session)
          pages.active = [{ ...session, time: { ...session.time, archived: undefined } }, ...pages.active]
          emit("session.unarchived", { sessionID: input.sessionID })
        }
      },
      remove: async (input) => {
        calls.push(["remove", input])
        pages.active = pages.active.filter((s) => s.id !== input.sessionID)
        emit("session.deleted", { sessionID: input.sessionID })
      },
      interrupt: async (input) => (calls.push(["interrupt", input]), { interrupted: true }),
      inbox: {
        update: async (input) => void calls.push(["inbox.update", input]),
        cancel: async (input) => void calls.push(["inbox.cancel", input]),
      },
      view: async (input) => {
        calls.push(["view", input])
        find(input.sessionID).time.viewed = input.idle
        emit("session.viewed", { sessionID: input.sessionID })
      },
    },
  }
  const data = {
    listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    session: {
      list: () => [],
      get: (id) => {
        const revert = live.revert[id]

        if (!parents[id] && !revert) return undefined

        return { id, parentID: parents[id], revert: revert ? { messageID: revert } : undefined }
      },
      message: { list: (id) => live.messages[id] ?? [] },
      root: (id) => id,
      family: () => [],
      active: () => Object.keys(running).filter((id) => running[id]),
      status: (id) => (running[id] ? "running" : "idle"),
      pending: { list: (id) => pendingItems[id] ?? [] },
      sync: async () => {},
      permission: { list: (id) => permissions[id] ?? [], sync: async () => {} },
      form: { list: () => [], sync: async () => {} },
    },
    project: { get: () => ({ id: "p1", name: "Demo project" }) },
  }
  const ref = { id: "local", name: "Local", url: "http://x", connected: true, local: true, builtin: true, compatible: true, client, data }

  return {
    ref,
    calls,
    pages,
    pendingItems,
    parents,
    setLive,
    emit,
    /** Starts or ends a run, as the server's events would. */
    setRunning(id, on) {
      const session = find(id)
      if (on) session.time.busy = Date.now()
      else session.time.idle = Date.now() + 1
      setRunning(id, on)
      emit(on ? "session.execution.started" : "session.idle", { sessionID: id })
    },
  }
}

function fakeContext(server, options = {}) {
  const added = []
  const log = { toasts: [], opened: [], commands: [], settings: [], prompts: [], confirms: [], copied: [] }
  const answers = { prompt: [], confirm: [] }
  const controller = new AbortController()
  const [state, setState] = createStore(structuredClone(def.stores.sidebar.initial))
  const [current, setCurrent] = createSignal()
  const messages = def.i18n.en
  const fill = (text, params = {}) => text.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(params[k] ?? ""))
  // Stand-ins for the app's components: the title and description as text, then the children.
  const el = (tag, ui, p) => {
    const n = document.createElement(tag)
    n.dataset.ui = ui
    for (const key of ["title", "description"]) if (p && key in p) web.insert(n, () => [p[key], " "])
    if (p && "children" in p) web.insert(n, () => p.children)
    return n
  }

  const ctx = {
    id: "sidebar-sections",
    options: {},
    signal: controller.signal,
    add: (reg, item) => (added.push([reg.id, item]), () => {}),
    t: (key, params) => fill(messages[key] ?? key, params),
    plural: (key, count, params) => fill(messages[`${key}.${count === 1 ? "one" : "other"}`] ?? key, { ...params, count }),
    stores: {
      sidebar: {
        get value() {
          return state
        },
        ready: () => true,
        update: (mutate) => setState(produce(mutate)),
        set: (next) => setState(next),
      },
    },
    servers: { list: () => ["local"], get: (id) => (id === "local" ? server.ref : undefined) },
    sessions: { list: () => options.sessions ?? [], current },
    system: { copy: async (text) => void log.copied.push(text) },
    tabs: { list: () => [], open: (session, opts) => log.opened.push([session, opts]), close: () => {}, focus: () => {}, move: () => {} },
    commands: { run: (id) => (log.commands.push(id), true) },
    dialogs: {
      active: () => false,
      prompt: async (o) => (log.prompts.push(o), answers.prompt.shift()),
      confirm: async (o) => (log.confirms.push(o), answers.confirm.shift() ?? false),
    },
    toast: { show: (o) => (log.toasts.push(o), { dismiss() {} }) },
    layout: { ready: () => true, narrow: () => false, settings: (page) => (log.settings.push(page), options.onSettings?.(page)) },
    router: { path: () => options.path ?? "/", routing: () => false },
    ui: {
      Icon: () => el("i", "Icon"),
      Button: (p) => el("button", "Button", p),
      IconButton: (p) => {
        const n = el("button", "IconButton")
        n.onclick = (event) => p.onClick?.(event)
        createRenderEffect(() => {
          n.setAttribute("aria-label", p.label)
          n.disabled = !!p.disabled
        })
        return n
      },
      Tooltip: (p) => el("span", "Tooltip", { children: p.children }),
      Menu: () => el("div", "Menu"),
      Switch: () => el("input", "Switch"),
      SettingsLayout: (p) => el("div", "SettingsLayout", p),
      SettingsSection: (p) => el("section", "SettingsSection", p),
      SettingsRow: (p) => el("div", "SettingsRow", p),
    },
  }

  return { ctx, added, log, answers, state, setCurrent, abort: () => controller.abort() }
}

/** The part of the app's window the plugin looks for. `layout` is what the shell would render. */
function appShell(layout) {
  document.body.innerHTML = ""
  const shell = document.createElement("div")
  shell.setAttribute("data-slot", "shell-drag-inset")
  document.body.appendChild(shell)
  if (layout === "top") return {}
  const sidebar = document.createElement("aside")
  sidebar.setAttribute("data-slot", "vertical-tabs-sidebar")
  document.body.appendChild(sidebar)
  if (layout === "side") return { sidebar }
  const native = nativeInbox()
  sidebar.appendChild(native)
  return { sidebar, native }
}

function nativeInbox() {
  const native = document.createElement("div")
  native.setAttribute("data-slot", "sidebar-inbox")
  native.innerHTML = '<span class="sr-only"></span><div data-slot="sidebar-inbox-scroll"><button data-slot="sidebar-inbox-item">native row</button></div>'
  return native
}

const q = (sel, root = document) => root.querySelector(sel)
const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel))
const group = (name) => q(`[data-ocsb-root] [data-group="${name}"]`)
const rowsOf = (root) => (root ? qa(".ocsb-row", root).map((n) => n.querySelector(".ocsb-row-title").textContent) : [])
const row = (title) => qa("[data-ocsb-root] .ocsb-row").find((n) => n.querySelector(".ocsb-row-title").textContent === title)
const sectionGroup = (name) => qa('[data-ocsb-root] [data-group="section"]').find((n) => n.querySelector(".ocsb-head-label").textContent === name)
const rightClick = (node) => node.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
const menuItems = () => qa("[data-ocsb-menu] .ocsb-menu-item").map((n) => n.textContent.replace("✓", "").trim())
const choose = (label) => qa("[data-ocsb-menu] .ocsb-menu-item").find((n) => n.textContent.replace("✓", "").trim() === label).click()

function start(server, options) {
  const fake = fakeContext(server, options)
  const dispose = createRoot((dispose) => {
    def.setup(fake.ctx)
    return dispose
  })

  return { ...fake, dispose: () => (fake.abort(), dispose()) }
}

async function listScenario() {
  console.log("== Inbox layout: the plugin's list replaces the app's")
  const { native, sidebar } = appShell("inbox")
  const server = fakeServer()
  const app = start(server)
  await tick(120)

  const root = q("[data-ocsb-root]")
  check(!!root && root.parentElement === native, "the list is mounted inside the app's Inbox list")
  check(native.lastElementChild === root, "it is the last child, so the app's own nodes keep their order")
  // The build minifies the stylesheet, so compare without quotes and spaces.
  const css = (app.added.find(([id]) => id === "style")?.[1] ?? "").replace(/["\s]/g, "")
  check(css.includes("[data-slot=sidebar-inbox]:has(>[data-ocsb-root])>:not([data-ocsb-root]){display:none!important}"), "a stylesheet hides the app's rows while the list is mounted")
  check(server.calls.filter(([name]) => name === "list").length === 2, "one page of active and one of archived sessions is fetched")

  check(JSON.stringify(rowsOf(group("needs"))) === '["Needs a permission"]', "a session waiting on a permission is under Needs attention")
  check(group("working") === null && q(".ocsb-shelf") === null, "there is no Working shelf")
  check(JSON.stringify(rowsOf(group("recent"))) === '["Finished, unread","Read already","New session","Still running"]', "Recent lists by when the last run ended; a generated title shows as New session")
  check(row("Still running").querySelector('.ocsb-status[data-status="working"]') !== null, "a running session shows a spinner where it is")
  check(row("Finished, unread").querySelector('.ocsb-status[data-status="done"]') !== null, "an unread result has a dot")
  check(row("Read already").querySelector(".ocsb-status") === null, "a read session has none")
  check(row("Read already").querySelector(".ocsb-row-project").textContent === "Demo project", "the row names its project")
  check(group("archived") !== null && rowsOf(group("archived")).length === 0 && group("archived").querySelector(".ocsb-head-count").textContent === "1", "Archived is a section, collapsed at first, with a count")

  group("archived").querySelector("button.ocsb-head").click()
  await tick()
  check(JSON.stringify(rowsOf(group("archived"))) === '["Old and archived"]' && app.state.collapsed.archived === false, "clicking its header expands Archived")
  group("archived").querySelector("button.ocsb-head").click()
  await tick()
  check(rowsOf(group("archived")).length === 0, "and collapses it again")

  console.log("== Right-click menus and sections")
  rightClick(q(".ocsb-scroll"))
  await tick()
  check(JSON.stringify(menuItems()) === '["New session","New section…"]', "right-click on the list offers New session and New section")
  choose("New session")
  await tick()
  check(app.log.commands[0] === "session.new" && q("[data-ocsb-menu]") === null, "New session runs the app's command and closes the menu")

  rightClick(q(".ocsb-scroll"))
  await tick()
  app.answers.prompt.push("  Work  ")
  choose("New section…")
  await tick()
  check(app.state.sections.length === 1 && app.state.sections[0].name === "Work", "New section asks for a name and creates the section")
  check(!!sectionGroup("Work") && sectionGroup("Work").querySelector(".ocsb-note").textContent === "Drop sessions here", "the empty section shows with a hint")
  const order = qa("[data-ocsb-root] .ocsb-scroll > [data-group]").map((n) => n.dataset.group)
  check(JSON.stringify(order) === '["needs","section","recent","archived"]', "groups are ordered: Needs attention, sections, Recent, Archived")

  rightClick(row("Read already"))
  await tick()
  check(JSON.stringify(menuItems()) === '["Work","New section…","Rename…","Archive","Delete…"]', "a session's menu lists the sections, rename, archive and delete")
  choose("Work")
  await tick()
  const workID = app.state.sections[0].id
  check(app.state.assigned["local\ns-read"] === workID, "choosing a section stores the assignment")
  check(JSON.stringify(rowsOf(sectionGroup("Work"))) === '["Read already"]' && !rowsOf(group("recent")).includes("Read already"), "the session moves from Recent into the section")

  rightClick(row("Read already"))
  await tick()
  const items = qa("[data-ocsb-menu] .ocsb-menu-item")
  check(items[0].getAttribute("aria-checked") === "true" && menuItems().includes("Remove from section"), "its menu now checks the section and offers Remove from section")
  q("[data-ocsb-menu]").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await tick()
  check(q("[data-ocsb-menu]") === null, "Escape closes the menu")

  sectionGroup("Work").querySelector("button.ocsb-head").click()
  await tick()
  check(rowsOf(sectionGroup("Work")).length === 0 && sectionGroup("Work").querySelector(".ocsb-head").hasAttribute("data-collapsed"), "a section collapses from its header")
  app.setCurrent({ id: "s-read", server: server.ref })
  await tick()
  check(JSON.stringify(rowsOf(sectionGroup("Work"))) === '["Read already"]' && row("Read already").dataset.state === "active", "a collapsed section still shows the open session")
  app.setCurrent(undefined)
  sectionGroup("Work").querySelector("button.ocsb-head").click()
  await tick()

  console.log("== A running session stays in place")
  const recentBefore = JSON.stringify(rowsOf(group("recent")))
  server.setRunning("s-read", true)
  server.setRunning("s-gen", true)
  await tick(600)
  check(JSON.stringify(rowsOf(sectionGroup("Work"))) === '["Read already"]' && row("Read already").querySelector('.ocsb-status[data-status="working"]') !== null, "a sectioned session stays in its section while it runs, with a spinner")
  check(JSON.stringify(rowsOf(group("recent"))) === recentBefore && row("New session").querySelector('.ocsb-status[data-status="working"]') !== null, "a session in Recent keeps its position while it runs")
  sectionGroup("Work").querySelector("button.ocsb-head").click()
  await tick()
  check(sectionGroup("Work").querySelector('.ocsb-head .ocsb-status[data-status="working"]') !== null, "a collapsed section shows a spinner on its header while a session in it runs")
  sectionGroup("Work").querySelector("button.ocsb-head").click()
  server.setRunning("s-read", false)
  server.setRunning("s-gen", false)
  await tick(600)
  check(JSON.stringify(rowsOf(sectionGroup("Work"))) === '["Read already"]' && row("Read already").querySelector('.ocsb-status[data-status="done"]') !== null, "when the run ends it is still in its section, with an unread dot")
  check(rowsOf(group("recent"))[0] === "New session", "and a finished session moves to the top of Recent")

  rightClick(row("Read already"))
  await tick()
  check(menuItems().includes("Mark as read"), "an unread session offers Mark as read")
  choose("Mark as read")
  await tick(600)
  check(server.calls.some(([name, input]) => name === "view" && input.sessionID === "s-read") && row("Read already").querySelector(".ocsb-status") === null, "which reports the view to the server and clears the dot")

  console.log("== Drag and drop, rename, archive, delete")
  const drag = (type, node) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    event.dataTransfer = { setData() {}, getData: () => "", effectAllowed: "", dropEffect: "" }
    node.dispatchEvent(event)
    return event
  }
  drag("dragstart", row("Finished, unread"))
  const over = drag("dragover", sectionGroup("Work"))
  await tick()
  check(over.defaultPrevented && sectionGroup("Work").hasAttribute("data-drop"), "dragging a session over a section marks it as the drop target")
  drag("drop", sectionGroup("Work"))
  await tick()
  check(app.state.assigned["local\ns-done"] === workID && rowsOf(sectionGroup("Work")).includes("Finished, unread") && !sectionGroup("Work").hasAttribute("data-drop"), "dropping it moves the session into the section")
  drag("dragstart", row("Finished, unread"))
  drag("dragover", group("recent"))
  drag("drop", group("recent"))
  await tick()
  check(app.state.assigned["local\ns-done"] === undefined && rowsOf(group("recent")).includes("Finished, unread"), "dropping on Recent takes it out of the section")

  rightClick(row("Read already"))
  await tick()
  app.answers.prompt.push("Renamed session")
  choose("Rename…")
  await tick(600)
  check(server.calls.some(([name, input]) => name === "update" && input.title === "Renamed session") && !!row("Renamed session"), "Rename asks for a title and updates the session")

  rightClick(row("Renamed session"))
  await tick()
  choose("Archive")
  await tick(600)
  check(server.calls.some(([name, input]) => name === "update" && input.archived === true), "Archive calls the server")
  check(rowsOf(sectionGroup("Work")).length === 0 && group("archived").querySelector(".ocsb-head-count").textContent === "2", "the session leaves its section and counts under Archived")
  group("archived").querySelector("button.ocsb-head").click()
  await tick()
  rightClick(row("Renamed session"))
  await tick()
  check(menuItems().includes("Unarchive"), "an archived session offers Unarchive")
  choose("Unarchive")
  await tick(600)
  check(JSON.stringify(rowsOf(sectionGroup("Work"))) === '["Renamed session"]', "unarchived, it is back in its section")

  rightClick(row("New session"))
  await tick()
  app.answers.confirm.push(true)
  choose("Delete…")
  await tick(600)
  check(app.log.confirms.length === 1 && server.calls.some(([name, input]) => name === "remove" && input.sessionID === "s-gen") && !row("New session"), "Delete asks first, then removes the session")

  row("Finished, unread").click()
  check(app.log.opened.length === 1 && app.log.opened[0][0].id === "s-done" && app.log.opened[0][1].focus === true, "clicking a row opens the session's tab")

  console.log("== Reordering sections")
  rightClick(q(".ocsb-scroll"))
  await tick()
  app.answers.prompt.push("Later")
  choose("New section…")
  await tick()
  const names = () => qa('[data-ocsb-root] [data-group="section"] .ocsb-head-label').map((n) => n.textContent)
  check(JSON.stringify(names()) === '["Work","Later"]', "a second section is added after the first")
  rightClick(q(".ocsb-scroll"))
  await tick()
  check(menuItems().includes("Collapse all sections"), "with two sections the list menu offers Collapse all")
  q("[data-ocsb-menu]").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  const dragAt = (type, node, clientY) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    event.dataTransfer = { setData() {}, getData: () => "", effectAllowed: "", dropEffect: "" }
    event.clientY = clientY
    node.dispatchEvent(event)
    return event
  }
  const head = (name) => sectionGroup(name).querySelector("button.ocsb-head")
  check(head("Later").draggable === true || head("Later").getAttribute("draggable") === "true", "a section's header is draggable")
  // jsdom lays nothing out, so every box is at 0: a pointer at 0 is the upper half, one below it the lower half.
  dragAt("dragstart", head("Later"), 0)
  dragAt("dragover", sectionGroup("Work"), 0)
  await tick()
  check(sectionGroup("Work").getAttribute("data-drop-edge") === "before" && sectionGroup("Later").hasAttribute("data-dragging"), "dragging it over another section marks where it would land")
  dragAt("drop", sectionGroup("Work"), 0)
  await tick()
  check(JSON.stringify(names()) === '["Later","Work"]' && !sectionGroup("Work").hasAttribute("data-drop-edge"), "dropping on the upper half puts it before that section")
  dragAt("dragstart", head("Later"), 0)
  dragAt("dragover", sectionGroup("Work"), 10)
  dragAt("drop", sectionGroup("Work"), 10)
  await tick()
  check(JSON.stringify(names()) === '["Work","Later"]' && JSON.stringify(app.state.sections.map((s) => s.name)) === '["Work","Later"]', "dropping on the lower half puts it after, and the order is stored")
  dragAt("dragstart", head("Later"), 0)
  const onRecent = dragAt("dragover", group("recent"), 0)
  check(!onRecent.defaultPrevented, "a section cannot be dropped on Recent")
  dragAt("dragend", head("Later"), 0)
  rightClick(head("Later"))
  await tick()
  app.answers.confirm.push(true)
  choose("Delete section…")
  await tick()
  check(JSON.stringify(names()) === '["Work"]', "the extra section is deleted again")

  console.log("== Section menu")
  rightClick(sectionGroup("Work").querySelector(".ocsb-head"))
  await tick()
  check(JSON.stringify(menuItems()) === '["New session","New section…","Rename section…","Move up","Move down","Delete section…"]', "a section header's menu can rename, move and delete it")
  app.answers.confirm.push(true)
  choose("Delete section…")
  await tick()
  check(app.state.sections.length === 0 && Object.keys(app.state.assigned).length === 0 && rowsOf(group("recent")).includes("Renamed session"), "deleting a section sends its sessions back to Recent")

  console.log("== Following the app's layout")
  check(app.log.settings.length === 0, "in the Inbox layout the plugin never opens Settings")
  native.remove()
  await tick(120)
  check(q("[data-ocsb-root]") === null, "when the app removes its Inbox list, the plugin's list goes too")
  const again = nativeInbox()
  sidebar.appendChild(again)
  await tick(120)
  check(q("[data-ocsb-root]")?.parentElement === again && rowsOf(group("recent")).length > 0, "and mounts again when the Inbox list comes back")
  app.dispose()
  await tick(60)
  check(q("[data-ocsb-root]") === null && again.children.length === 2, "disabling the plugin removes its list and leaves the app's untouched")
}

async function layoutScenario(layout, found) {
  console.log(`== ${layout === "top" ? "Top tabs" : "Side tabs"} layout${found ? "" : ", setting not found"}`)
  appShell(layout)
  const server = fakeServer()
  let radio
  const app = start(server, {
    onSettings: () => {
      if (!found) return
      // The app's Settings › General › Interface mode.
      const field = document.createElement("fieldset")
      field.setAttribute("data-component", "interface-mode")
      field.innerHTML = '<input type="radio" name="m" value="top" checked><input type="radio" name="m" value="side"><input type="radio" name="m" value="inbox">'
      document.body.appendChild(field)
      radio = field.querySelector('input[value="inbox"]')
    },
  })
  await tick(100)
  check(q("[data-ocsb-root]") === null && server.calls.length === 0, "without the Inbox list nothing is mounted and nothing is fetched")
  await tick(found ? 1800 : 5800)
  check(app.log.settings[0] === "general", "the plugin opens Settings › General")

  if (found) {
    check(radio?.checked === true, "and chooses Inbox")
    check(app.log.toasts.length === 1 && app.log.toasts[0].title === "Switched to the Inbox layout", "then says that it switched")
  } else {
    check(app.log.toasts.length === 1 && app.log.toasts[0].title === "Sidebar sections need the Inbox layout" && app.log.toasts[0].actions.length === 1, "when it cannot find the setting, it asks the user to switch, with a button")
  }

  await tick(300)
  check(app.log.settings.length === 1, "it tries once per window, not in a loop")
  app.dispose()
}

async function pendingScenario() {
  console.log("== Actions under a waiting message")
  appShell("inbox")
  const server = fakeServer()
  server.pendingItems["s-run"] = [{ id: "msg1", sessionID: "s-run", type: "user", delivery: "steer", payload: { text: "Do this next" }, time: { created: NOW } }]
  // The app's markup for a message sent while the agent works (session-ui message-content.tsx).
  const message = (id, pending) => {
    const node = document.createElement("div")
    node.setAttribute("data-component", "user-message")
    if (pending) node.setAttribute("data-pending", "true")
    if (id) node.setAttribute("data-timeline-part-id", `${id}:text:0`)
    node.innerHTML = '<div data-slot="user-message-body"><div data-slot="user-message-text">shown text</div></div><div data-slot="user-message-copy-wrapper"><span data-slot="user-message-meta-wrap">Pending</span></div>'
    document.body.appendChild(node)
    return node
  }
  const waiting = message("msg1", true)
  const delivered = message("msg0", false)
  const noID = message(undefined, true)
  const app = start(server, { sessions: [{ id: "s-run", server: server.ref }] })
  await tick(200)

  const bar = () => q("[data-ocsb-pending]", waiting)
  const labels = () => qa("[data-ocsb-pending] button", waiting).map((n) => n.getAttribute("aria-label"))
  const press = (label) => qa("[data-ocsb-pending] button", waiting).find((n) => n.getAttribute("aria-label") === label).click()
  const footer = q('[data-slot="user-message-copy-wrapper"]', waiting)
  check(!!bar() && bar().parentElement === footer && footer.lastElementChild === bar(), "a waiting message gets a row of buttons at the end of its Pending line")
  check(JSON.stringify(labels()) === '["Interrupt and send now","Move to queue","Delete","Copy message"]', "the row offers Interrupt and send now, Move to queue, Delete and Copy")
  check(q("[data-ocsb-pending]", delivered) === null && q("[data-ocsb-pending]", noID) === null && q("[data-ocsb-sent]", noID) === null, "a waiting message without an id gets none")

  // A sent message: Revert, Fork and Copy, each choosing the item of the app's own chevron menu.
  const sentLabels = (node) => qa("[data-ocsb-sent] button", node).map((n) => n.getAttribute("aria-label"))
  const pressSent = (node, label) => qa("[data-ocsb-sent] button", node).find((n) => n.getAttribute("aria-label") === label).click()
  const sentFooter = q('[data-slot="user-message-copy-wrapper"]', delivered)
  check(q("[data-ocsb-sent]", delivered)?.parentElement === sentFooter && sentFooter.lastElementChild === q("[data-ocsb-sent]", delivered), "a sent message gets a row of buttons at the end of the line under it")
  check(JSON.stringify(sentLabels(delivered)) === '["Revert to here","Fork from here","Copy message"]', "the row offers Revert to here, Fork from here and Copy")

  pressSent(delivered, "Copy message")
  await tick(900)
  check(app.log.copied.at(-1) === "shown text" && sentLabels(delivered)[2] === "Copied", "without the app's menu, Copy takes the text the page shows")
  pressSent(delivered, "Revert to here")
  await tick(900)
  check(app.log.toasts.at(-1)?.title === "The app does not offer this for the message", "and Revert says that the app does not offer it")
  await tick(700)

  // The app's chevron menu, as far as the plugin relies on it: it opens on a pointer press on its trigger, is named
  // by the trigger, and an item runs on pointer release. test/menu-drive.test.mjs checks this against the real menu.
  const chosen = []
  const withMenu = (node, icons) => {
    const slot = document.createElement("span")
    slot.setAttribute("data-slot", "user-message-menu")
    const trigger = document.createElement("button")
    trigger.id = `trigger-${node.getAttribute("data-timeline-part-id")}`
    trigger.setAttribute("aria-expanded", "false")
    slot.appendChild(trigger)
    q('[data-slot="user-message-text"]', node).appendChild(slot)
    trigger.addEventListener("pointerdown", () => {
      const menu = document.createElement("div")
      menu.id = `${trigger.id}-menu`
      menu.setAttribute("role", "menu")
      menu.setAttribute("data-component", "menu-v2-content")
      const close = () => {
        menu.remove()
        trigger.removeAttribute("aria-controls")
        trigger.setAttribute("aria-expanded", "false")
      }
      for (const icon of icons) {
        const item = document.createElement("div")
        item.setAttribute("data-component", "menu-v2-item")
        item.innerHTML = `<svg><use href="#opencode-v2-icon-${icon}"></use></svg>`
        item.addEventListener("pointerup", () => (chosen.push(icon), close()))
        menu.appendChild(item)
      }
      menu.addEventListener("keydown", (event) => event.key === "Escape" && close())
      document.body.appendChild(menu)
      trigger.setAttribute("aria-controls", menu.id)
      trigger.setAttribute("aria-expanded", "true")
    })
  }
  withMenu(delivered, ["copy", "fork", "reset"])
  const toasts = app.log.toasts.length
  pressSent(delivered, "Revert to here")
  await tick(200)
  pressSent(delivered, "Fork from here")
  await tick(200)
  pressSent(delivered, "Copy message")
  await tick(200)
  check(JSON.stringify(chosen) === '["reset","fork","copy"]' && app.log.toasts.length === toasts, "with the app's menu, each button chooses its item there: Revert, Fork, Copy")
  check(sentLabels(delivered)[2] === "Copied" && app.log.copied.length === 1 && q('[role="menu"]') === null && !document.documentElement.hasAttribute("data-ocsb-driving"), "Copy leaves the copying to the app, and the menu is closed again")

  // A subagent's session has no Revert or Fork in the app.
  server.parents["s-child"] = "s-run"
  app.setCurrent({ id: "s-child", server: server.ref })
  await tick()
  check(sentLabels(delivered).length === 1 && !sentLabels(delivered).includes("Revert to here"), "a subagent's session offers Copy only")
  app.setCurrent({ id: "s-run", server: server.ref })
  await tick()
  check(sentLabels(delivered).length === 3, "and the routed session's own messages offer all three again")

  press("Copy message")
  await tick()
  check(app.log.copied.at(-1) === "Do this next" && labels()[3] === "Copied", "Copy puts the message's own text on the clipboard")
  press("Interrupt and send now")
  await tick()
  check(JSON.stringify(server.calls.find(([name]) => name === "interrupt")?.[1]) === '{"sessionID":"s-run","resume":true}', "Interrupt and send now stops the running step and resumes with the waiting input")
  press("Move to queue")
  await tick()
  check(JSON.stringify(server.calls.find(([name]) => name === "inbox.update")?.[1]) === '{"sessionID":"s-run","inboxID":"msg1","delivery":"queue"}', "Move to queue changes the input's delivery, as the app's menu item does")
  press("Delete")
  await tick()
  check(JSON.stringify(server.calls.find(([name]) => name === "inbox.cancel")?.[1]) === '{"sessionID":"s-run","inboxID":"msg1"}', "Delete cancels the input")

  waiting.removeAttribute("data-pending")
  await tick(250)
  check(bar() === null && JSON.stringify(sentLabels(waiting)) === '["Revert to here","Fork from here","Copy message"]', "once the message is delivered its row becomes the one of a sent message")
  waiting.setAttribute("data-pending", "true")
  await tick(250)
  check(!!bar() && q("[data-ocsb-sent]", waiting) === null, "and the waiting row comes back for a message that waits again")
  app.ctx.stores.sidebar.update((draft) => {
    draft.pendingActions = false
  })
  await tick(250)
  check(bar() === null && q("[data-ocsb-sent]") === null, "turning the setting off removes the rows")
  app.ctx.stores.sidebar.update((draft) => {
    draft.pendingActions = true
  })
  await tick(250)
  app.dispose()
  await tick(60)
  check(q("[data-ocsb-pending]") === null && q("[data-ocsb-sent]") === null && footer.children.length === 1 && sentFooter.children.length === 1, "disabling the plugin leaves the messages as the app drew them")
}

async function railScenario() {
  console.log("== Jump rail for the user's messages")
  appShell("inbox")
  const server = fakeServer()
  const user = (id, text) => ({ id, type: "user", text, time: { created: NOW } })
  const reply = (id) => ({ id, type: "assistant", time: { created: NOW } })
  server.setLive("messages", "s-run", [user("m1", "First   question\nwith a second line"), reply("a1"), user("m2", "Second question"), reply("a2"), user("m3", "")])

  // The app's timeline, as far as the plugin relies on it (session/timeline/virtualizer.tsx): a root holding the
  // scrolling view with its rows, and a box over the visible part of it.
  const timeline = (visible) => {
    const root = document.createElement("div")
    root.innerHTML = '<div data-slot="session-timeline-scroll"></div><div data-slot="session-timeline-visible"></div>'
    document.body.appendChild(root)
    const area = root.lastElementChild
    // jsdom lays nothing out; a timeline on screen has a box, one kept in the background has none.
    area.getClientRects = () => (visible() ? [{}] : [])
    return { root, area, scroll: root.firstElementChild }
  }
  let front = "a"
  const a = timeline(() => front === "a")
  const b = timeline(() => front === "b")
  a.scroll.innerHTML = '<div id="message-m2" data-message-id="m2"></div><div data-message-id="m2"></div>'
  a.scroll.getBoundingClientRect = () => ({ top: 0, bottom: 600 })
  a.scroll.children[0].getBoundingClientRect = () => ({ top: -300, bottom: -240 })
  a.scroll.children[1].getBoundingClientRect = () => ({ top: -240, bottom: 500 })

  // The app's router, as far as the plugin relies on it: it follows a same-origin link in the page and cancels the click.
  const routed = []
  const route = (event) => {
    const link = event.composedPath().find((node) => node.nodeName === "A")
    if (!link || event.defaultPrevented) return
    const url = new dom.window.URL(link.href)
    routed.push({ to: url.pathname + url.search + url.hash, replace: link.hasAttribute("replace"), noscroll: link.hasAttribute("noscroll") })
    event.preventDefault()
  }
  document.addEventListener("click", route)

  const app = start(server, { path: "/server/local/session/s-run" })
  app.setCurrent({ id: "s-run", key: "local\ns-run", server: server.ref })
  await tick(400)

  const rail = () => q("[data-ocsb-rail]")
  const lines = () => qa("[data-ocsb-rail] .ocsb-rail-item")
  const over = (node) => node.dispatchEvent(new dom.window.MouseEvent("mouseenter"))
  check(rail()?.parentElement === a.area && q("[data-ocsb-rail]", b.root) === null, "the rail is in the timeline that is on screen, in the app's box over its visible part")
  check(lines().length === 3 && lines().every((n) => n.tagName === "BUTTON" && n.querySelector(".ocsb-rail-line")), "it has one line per message of the user, none for the replies")
  check(q('[data-ocsb-rail] [role="navigation"]')?.getAttribute("aria-label") === "Your messages", "and is named for assistive tech")
  check(lines()[1].hasAttribute("data-active") && !lines()[0].hasAttribute("data-active"), "the line of the message being read is marked")

  check(q(".ocsb-rail-tip") === null, "no preview shows until the pointer is over a line")
  over(lines()[0])
  await tick()
  check(q(".ocsb-rail-tip-text")?.textContent === "First question with a second line" && q(".ocsb-rail-tip-count")?.textContent === "1/3", "pointing at a line shows the start of its message and its place")
  over(lines()[2])
  await tick()
  check(q(".ocsb-rail-tip-text")?.textContent === "Message without text", "a message of only attachments says so")
  check(!!q(".ocsb-rail-tip"), "the preview stays while the pointer is in the rail")
  q(".ocsb-rail").dispatchEvent(new dom.window.MouseEvent("mouseleave"))
  await tick()
  check(q(".ocsb-rail-tip") === null, "and goes when the pointer leaves it")

  lines()[0].click()
  await tick()
  check(JSON.stringify(routed) === '[{"to":"/server/local/session/s-run#message-m1","replace":true,"noscroll":true}]', "a click sends the app's router to the message, on the current route, without a new history entry")
  check(lines()[0].hasAttribute("data-active") && !lines()[1].hasAttribute("data-active"), "and marks its line")
  a.scroll.dispatchEvent(new dom.window.Event("scroll"))
  await tick(60)
  check(lines()[1].hasAttribute("data-active"), "scrolling the timeline moves the mark to the message in view")

  server.setLive("messages", "s-run", (list) => [...list, reply("a3"), user("m4", "Fourth")])
  await tick()
  check(lines().length === 4, "a new message adds a line")
  server.setLive("revert", "s-run", "m3")
  await tick()
  check(lines().length === 2, "messages a revert hides have no line")
  server.setLive("revert", "s-run", undefined)
  await tick()

  // Another session is routed: its timeline comes on screen, the first one goes to the background.
  server.setLive("messages", "s-done", [user("d1", "Only one")])
  front = "b"
  app.setCurrent({ id: "s-done", key: "local\ns-done", server: server.ref })
  await tick(400)
  check(rail()?.parentElement === b.area && q("[data-ocsb-rail]", a.root) === null, "routing another session moves the rail to its timeline")
  check(lines().length === 0, "a session with a single message shows no lines")
  front = "a"
  app.setCurrent({ id: "s-run", key: "local\ns-run", server: server.ref })
  await tick(400)
  check(rail()?.parentElement === a.area && lines().length === 4, "and back")

  app.ctx.stores.sidebar.update((draft) => {
    draft.jumpRail = false
  })
  await tick(300)
  check(rail() === null && q("a[data-ocsb-jump]") === null, "turning the setting off removes the rail and its link")
  app.ctx.stores.sidebar.update((draft) => {
    draft.jumpRail = true
  })
  await tick(300)
  check(!!rail(), "turning it on brings the rail back")
  app.dispose()
  await tick(60)
  check(rail() === null && q("a[data-ocsb-jump]") === null && a.area.children.length === 0, "disabling the plugin leaves the timeline as the app drew it")
  document.removeEventListener("click", route)
}

async function settingsScenario() {
  console.log("== Settings page and commands")
  appShell("inbox")
  const server = fakeServer()
  const app = start(server)
  await tick(100)
  const page = app.added.find(([id]) => id === "settings")?.[1]
  check(page?.id === "sidebar" && page.title === "Sidebar" && page.entries.length === 5, "a Sidebar settings page is registered with search entries")
  const commands = app.added.filter(([id]) => id === "command").map(([, item]) => item())
  check(JSON.stringify(commands.map((c) => c.id)) === '["new-section","inbox-layout"]', "two palette commands are registered")
  app.answers.prompt.push("From palette")
  commands[0].run()
  await tick()
  check(app.state.sections[0]?.name === "From palette" && !!sectionGroup("From palette"), "the New section command creates a section")
  const view = createRoot(() => page.render({}))
  await tick()
  check(view.dataset.ui === "SettingsLayout" && view.textContent.includes("From palette") && view.textContent.includes("0 sessions"), "the page lists the sections with their session counts")
  check(view.textContent.includes("The sidebar list is active in this window."), "and says the list is active")
  app.dispose()
}

;(async () => {
  await listScenario()
  await layoutScenario("top", true)
  await layoutScenario("side", true)
  await layoutScenario("top", false)
  await pendingScenario()
  await railScenario()
  await settingsScenario()
  console.log(failed ? "\nFAILED" : "\nall checks passed")
  process.exit(failed ? 1 : 0)
})().catch((cause) => {
  console.error(cause)
  process.exit(1)
})
