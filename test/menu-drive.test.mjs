// Checks `src/drive.ts` against the real menu component the app uses for a message's "More actions" menu: Kobalte's
// dropdown menu, same version as Desktop 2.3.2 (0.13.13), rendered in jsdom with the markup the app gives it.
// Usage: node --conditions browser --import tsx test/menu-drive.test.mjs
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" })
const win = dom.window

// This jsdom has no PointerEvent; the app's Chromium does. A mouse event that names its pointer is all the menu reads.
win.PointerEvent ??= class PointerEvent extends win.MouseEvent {
  constructor(type, init = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? ""
    this.isPrimary = !!init.isPrimary
  }
}

// Node has its own Event classes and navigator; the page's must win, or jsdom refuses the events.
const keep = new Set(["setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "console", "performance", "structuredClone", "globalThis", "process", "undefined", "Infinity", "NaN"])

for (const key of Object.getOwnPropertyNames(win)) {
  if (keep.has(key) || /^(Array|Object|Function|Number|String|Boolean|Symbol|Promise|Map|Set|Weak|Error|.*Error$|JSON|Math|Reflect|Proxy|Date|RegExp|BigInt|Intl|eval|parse|is|escape|unescape|encode|decode|Uint|Int|Float|Data|Atomics|Shared|WebAssembly|Iterator|Async|Finalization|Aggregate)/.test(key)) continue

  try {
    Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true })
  } catch {
    // A global Node will not give up is one the menu does not need.
  }
}

globalThis.window = win
// jsdom has no layout, so the observers the menu's positioning asks for have nothing to report.
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = win.ResizeObserver = Observer
globalThis.IntersectionObserver = win.IntersectionObserver = Observer
win.Element.prototype.scrollIntoView ??= () => {}
// The menu puts the page's scroll position back when it closes.
globalThis.scrollTo = win.scrollTo = () => {}

// A closing menu stays in the page until its exit animation ends. jsdom reports no animation name at all, which the
// menu reads as one that never ends; here there is none.
const computed = win.getComputedStyle.bind(win)

globalThis.getComputedStyle = win.getComputedStyle = (element, pseudo) => {
  const style = computed(element, pseudo)

  return new Proxy(style, {
    get: (target, key) => {
      if (key === "animationName") return "none"
      const value = target[key]

      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

const { createComponent, render } = await import("solid-js/web")
const { DropdownMenu } = await import("@kobalte/core/dropdown-menu")
const { chooseMessageAction, DRIVING } = await import("../src/drive.ts")

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = false

const check = (ok, label) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label)
  if (!ok) failed = true
}

/** A sent message as the app draws it, with its chevron menu. `items` are [icon, label, disabled?]. */
function message(items, log) {
  const node = document.createElement("div")
  node.setAttribute("data-component", "user-message")
  node.innerHTML =
    '<div data-slot="user-message-body"><div data-slot="user-message-text"><span>hello there</span><span data-slot="user-message-menu"></span></div></div><div data-slot="user-message-copy-wrapper"></div>'
  document.body.appendChild(node)

  const item = ([icon, label, disabled]) =>
    createComponent(DropdownMenu.Item, {
      "data-component": "menu-v2-item",
      disabled,
      onSelect: () => log.push(label),
      get children() {
        const content = document.createElement("span")
        content.setAttribute("data-slot", "menu-v2-item-content")
        content.innerHTML = (icon ? `<svg data-slot="icon-svg"><use href="#opencode-v2-icon-${icon}"></use></svg>` : "") + label

        return content
      },
    })

  render(
    () =>
      createComponent(DropdownMenu, {
        get children() {
          return [
            createComponent(DropdownMenu.Trigger, { "aria-label": "More actions" }),
            createComponent(DropdownMenu.Portal, {
              get children() {
                return createComponent(DropdownMenu.Content, {
                  "data-component": "menu-v2-content",
                  get children() {
                    return items.map(item)
                  },
                })
              },
            }),
          ]
        },
      }),
    node.querySelector('[data-slot="user-message-menu"]'),
  )

  return node
}

const open = () => document.querySelectorAll('[role="menu"]').length
const hidden = () => document.documentElement.hasAttribute(DRIVING)

console.log("== Choosing an item of the app's message menu")
const composer = document.createElement("input")
document.body.appendChild(composer)
composer.focus()

const log = []
const sent = message([["copy", "Copy message"], ["fork", "Fork from here"], ["reset", "Revert to here"]], log)
check(!!sent.querySelector('[data-slot="user-message-menu"] button[aria-haspopup]') && open() === 0, "the message has a closed chevron menu")

const reverting = chooseMessageAction(sent, "revert")
check(hidden(), "the menu is kept out of sight while it is driven")
check((await reverting) === "done" && JSON.stringify(log) === '["Revert to here"]', "Revert chooses the menu's Revert item, once")
await tick(150)
check(open() === 0 && !hidden(), "the menu closes again and the hiding ends")
check(document.activeElement === composer, "the focus goes back to where it was")

check((await chooseMessageAction(sent, "copy")) === "done" && log.at(-1) === "Copy message", "Copy chooses Copy message")
await tick(150)
check((await chooseMessageAction(sent, "fork")) === "done" && log.at(-1) === "Fork from here" && log.length === 3, "Fork chooses Fork from here")
await tick(150)

const busyLog = []
const busy = message([["copy", "Copy message"], ["fork", "Fork from here", true], ["reset", "Revert to here"]], busyLog)
check((await chooseMessageAction(busy, "fork")) === "disabled" && busyLog.length === 0, "an item the app has switched off is not chosen")
await tick(150)
check(open() === 0 && !hidden(), "and the menu is closed")

const childLog = []
const child = message([["copy", "Copy message"]], childLog)
check((await chooseMessageAction(child, "revert")) === "missing" && childLog.length === 0, "a menu without Revert reports it missing")
await tick(150)
check(open() === 0 && !hidden(), "and the menu is closed")

const twice = [chooseMessageAction(sent, "copy"), chooseMessageAction(sent, "revert")]
check(JSON.stringify(await Promise.all(twice)) === '["done","unavailable"]', "a second action waits for the first to finish")
await tick(150)

const plainLog = []
const plain = message([[undefined, "Copy message"], [undefined, "Revert to here"]], plainLog)
check((await chooseMessageAction(plain, "revert")) === "shown" && plainLog.length === 0, "items that cannot be told apart are not guessed")
await tick(150)
check(open() === 1 && !hidden(), "the app's menu is left open and visible for the user instead")

const bare = document.createElement("div")
bare.innerHTML = '<div data-slot="user-message-copy-wrapper"></div>'
document.body.appendChild(bare)
check((await chooseMessageAction(bare, "copy")) === "unavailable", "a message without a menu reports that")

console.log(failed ? "\nFAILED" : "\nall checks passed")
process.exit(failed ? 1 : 0)
