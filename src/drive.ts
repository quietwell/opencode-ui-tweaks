/**
 * Runs one of the app's own actions on a sent message: Copy, Fork from here or Revert to here.
 *
 * Reverting and forking are more than a server call in the app: they put the prompt back in the composer, offer Undo
 * and move the timeline. A plugin cannot reach that code, so this chooses the item in the message's own "More actions"
 * menu (the chevron on the bubble), with the menu kept out of sight meanwhile.
 *
 * The menu is Kobalte's dropdown menu (`packages/ui/src/navigation/menu/menu.tsx`): its trigger opens on a pointer
 * press and an item runs on pointer release. `test/menu-drive.test.mjs` checks both against the real component.
 */
export type MessageAction = "copy" | "fork" | "revert"

/**
 * - `done`: the item was chosen.
 * - `disabled`: the app has the item switched off right now, e.g. while a revert runs.
 * - `missing`: the menu has no such item, e.g. Revert in a subagent's session.
 * - `shown`: the menu's items could not be told apart, so it was left open for the user to choose.
 * - `unavailable`: the message has no menu, or it did not open.
 */
export type DriveResult = "done" | "disabled" | "missing" | "shown" | "unavailable"

const TRIGGER = '[data-slot="user-message-menu"] button'
const ITEM = '[data-component="menu-v2-item"]'

/** The icon each item carries (`packages/session-ui/src/message/message-content.tsx`). */
const ICON: Record<MessageAction, string> = { copy: "copy", fork: "fork", revert: "reset" }

/** Set on the root element while a menu is driven; the stylesheet hides the app's menus meanwhile. */
export const DRIVING = "data-ocsb-driving"

const STEP = 16

let driving = false

const until = async <T>(read: () => T | undefined, timeout: number) => {
  const end = Date.now() + timeout

  for (;;) {
    const value = read()

    if (value !== undefined || Date.now() >= end) return value
    await new Promise((resolve) => setTimeout(resolve, STEP))
  }
}

/** The open menu of a trigger: Kobalte names it on the trigger, and names the trigger on the menu. */
const menuOf = (trigger: HTMLElement) => {
  const document = trigger.ownerDocument
  const id = trigger.getAttribute("aria-controls")
  const named = id ? document.getElementById(id) : null

  if (named) return named

  if (!trigger.id) return undefined

  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).find(
      (menu) => menu.getAttribute("aria-labelledby") === trigger.id,
    ) ?? undefined
  )
}

/** The icon name of a menu item: the app draws icons as `<use href="#opencode-v2-icon-<name>">`. */
const iconOf = (item: Element) => {
  const use = item.querySelector("use")
  const href = use?.getAttribute("href") ?? use?.getAttribute("xlink:href") ?? ""
  const at = href.lastIndexOf("-icon-")

  return at < 0 ? undefined : href.slice(at + "-icon-".length)
}

export async function chooseMessageAction(message: Element, action: MessageAction): Promise<DriveResult> {
  const trigger = message.querySelector<HTMLElement>(TRIGGER)
  const view = message.ownerDocument.defaultView

  if (!trigger || !view || typeof view.PointerEvent !== "function" || driving) return "unavailable"

  const document = message.ownerDocument
  const root = document.documentElement
  const focused = document.activeElement instanceof view.HTMLElement ? document.activeElement : undefined

  const press = (target: Element, type: "pointerdown" | "pointerup") =>
    target.dispatchEvent(
      new view.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true }),
    )

  const escape = (menu: Element) =>
    menu.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))

  // The menu closes a moment after an item is chosen and hands the focus to its chevron; it goes back to where it was,
  // usually the composer, unless the app has moved it on by then.
  const settle = async (reveal: boolean) => {
    if (!reveal) {
      await until(() => (menuOf(trigger) ? undefined : true), 1_000)

      const active = document.activeElement

      if (active === trigger || active === document.body || !active) {
        if (focused?.isConnected && focused !== trigger) focused.focus({ preventScroll: true })
        else trigger.blur()
      }
    }

    root.removeAttribute(DRIVING)
    driving = false
  }

  driving = true
  root.setAttribute(DRIVING, "")

  let reveal = false

  try {
    if (trigger.getAttribute("aria-expanded") !== "true") press(trigger, "pointerdown")

    const menu = await until(() => {
      const open = menuOf(trigger)

      return open?.querySelector(ITEM) ? open : undefined
    }, 800)

    if (!menu) return "unavailable"

    const items = Array.from(menu.querySelectorAll<HTMLElement>(ITEM))
    const item = items.find((entry) => iconOf(entry) === ICON[action])

    if (!item) {
      // An app update that draws the items differently: better the app's menu, open, than a button that does nothing.
      if (!items.some((entry) => iconOf(entry) === ICON.copy)) {
        reveal = true

        return "shown"
      }

      escape(menu)

      return "missing"
    }

    if (item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")) {
      escape(menu)

      return "disabled"
    }

    press(item, "pointerup")

    return "done"
  } finally {
    void settle(reveal)
  }
}

/** The text of a message as the page shows it, without the bubble's own controls. */
export function shownText(message: Element) {
  const text = message.querySelector('[data-slot="user-message-text"]')

  if (!text) return ""

  const copy = text.cloneNode(true) as Element
  copy.querySelectorAll('button, [data-slot="user-message-menu"]').forEach((node) => node.remove())

  return (copy.textContent ?? "").trim()
}
