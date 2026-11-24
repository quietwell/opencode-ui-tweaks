// Checks `src/jump.ts` against the router the app uses (@solidjs/router 1.0.0, as in Desktop 2.3.2): a jump must change
// the route's hash to `#message-<id>`, which is what the app's timeline acts on, and must never load an address in
// the window. The router's own parts are used, routing.js and data/events.js, wired to a memory source like the
// Desktop's memory router; its component file is JSX and is not needed for this.
// Usage: node --conditions browser --import tsx test/jump.test.mjs
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/index.html" })
const win = dom.window

for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "MouseEvent", "URL", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  Object.defineProperty(globalThis, key, { value: key === "window" ? win : win[key], configurable: true, writable: true })

// jsdom reports a navigation it cannot perform as an error on its virtual console. None may happen here.
const navigations = []
dom.virtualConsole.on("jsdomError", (error) => navigations.push(String(error.message ?? error)))

const { createRoot, createSignal, createEffect } = await import("solid-js")
const router = path.dirname(createRequire(import.meta.url).resolve("@solidjs/router"))
const { createRouterContext } = await import(pathToFileURL(path.join(router, "routing.js")).href)
const { setupNativeEvents } = await import(pathToFileURL(path.join(router, "data/events.js")).href)
const { createJumper, anchorOf, messageInView, scrollToRow } = await import("../src/jump.ts")

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = false

const check = (ok, label) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label)
  if (!ok) failed = true
}

const ROUTE = "/server/local/session/s1?tab=chat"

/** A router on a memory source, as `MemoryRouter` builds it, following links in the page. */
function startRouter() {
  const entries = [ROUTE]
  const hashes = []

  const dispose = createRoot((dispose) => {
    const [source, setSource] = createSignal({ value: ROUTE }, { equals: (a, b) => a.value === b.value && a.state === b.state })

    const signal = [
      source,
      (next) => {
        if (next.replace) entries[entries.length - 1] = next.value
        else entries.push(next.value)

        return setSource(next)
      },
    ]

    const state = createRouterContext({ signal, utils: {} }, () => [], () => undefined, {})
    setupNativeEvents({})(state)
    createEffect(() => hashes.push(state.location.hash))

    return dispose
  })

  return { entries, hashes, dispose }
}

console.log("== Jumping through the router")
const app = startRouter()
const jumper = createJumper(() => ROUTE)
await tick()
check(app.hashes.at(-1) === "" && document.querySelector("a[data-ocsb-jump]")?.hidden === true, "the jump link is in the page, hidden, and the route has no hash yet")

check(jumper.jump("m3") === true, "a jump is taken by the router")
await tick()
check(app.hashes.at(-1) === "#message-m3", "the route's hash names the message, which the app's timeline acts on")
check(app.entries.length === 1 && app.entries[0] === `${ROUTE}#message-m3`, "the route keeps its path and query, and no history entry is added")

jumper.jump("m1")
await tick()
check(app.hashes.at(-1) === "#message-m1" && app.entries.length === 1, "another jump replaces the hash")

// Asking for the same message again leaves the route as it is, so the app would not move.
const before = app.hashes.length
jumper.jump("m1", "m2")
await tick(200)
check(JSON.stringify(app.hashes.slice(before)) === '["#message-m2","#message-m1"]', "the same message again, not in the page: the route goes by way of another message and back")

// A row that is in the page is scrolled to directly.
const scroller = document.createElement("div")
scroller.setAttribute("data-slot", "session-timeline-scroll")
scroller.style.overflowY = "auto"
scroller.innerHTML = `<div data-session-title></div><div id="${anchorOf("m1")}" data-message-id="m1"></div><div data-message-id="m1"></div><div id="${anchorOf("m2")}" data-message-id="m2"></div>`
document.body.appendChild(scroller)
const [title, first, answer, secondRow] = scroller.children
const scrolls = []
const box = (top, height) => () => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300 })
Object.defineProperties(scroller, { scrollHeight: { value: 3000 }, clientHeight: { value: 600 }, scrollTop: { value: 900, writable: true } })
scroller.scrollTo = (options) => scrolls.push(options)
scroller.getBoundingClientRect = box(50, 600)
Object.defineProperty(title, "offsetHeight", { value: 48 })
first.getBoundingClientRect = box(-400, 60)
answer.getBoundingClientRect = box(-340, 700)
secondRow.getBoundingClientRect = box(360, 60)

const steady = app.hashes.length
check(jumper.jump("m1", "m2") === true && JSON.stringify(scrolls) === '[{"top":402,"behavior":"auto"}]', "the same message again, in the page: its row is scrolled under the session title")
await tick(150)
check(app.hashes.length === steady, "and the route is left alone")
check(messageInView(document.body) === "m1", "the message being read is the one whose turn is at the top of the view, here its answer")
first.getBoundingClientRect = box(-1400, 60)
answer.getBoundingClientRect = box(-1340, 700)
secondRow.getBoundingClientRect = box(100, 60)
check(messageInView(scroller) === "m2", "and the next one once its row reaches the top")
check(scrollToRow(document.createElement("div")) === false, "a row outside a scrolling element is not scrolled")

// Without a router that takes the link, the click must not load the address in the window.
app.dispose()
jumper.dispose()
const lone = createJumper(() => ROUTE)
const href = win.location.href
check(lone.jump("m9") === false && win.location.href === href && navigations.length === 0, "a link the router does not take is stopped, so the window never leaves the app")
scrolls.length = 0
check(lone.jump("m2") === true && scrolls.length === 1, "then a row in the page is still scrolled to")
check(createJumper(() => "").jump("m9") === false, "before the app has a route there is nothing to jump with")
lone.dispose()
check(document.querySelector("a[data-ocsb-jump][href]") === null, "disposing takes the link out of the page")

console.log(failed ? "\nFAILED" : "\nall checks passed")
process.exit(failed ? 1 : 0)
