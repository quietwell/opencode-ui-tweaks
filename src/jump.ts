/**
 * Jumping to one of the user's messages in the session timeline.
 *
 * The timeline is virtualized: only the rows near the view are in the page, so a far message cannot simply be scrolled
 * to. The app has the machinery for it (`packages/app/src/session/timeline/cursor.ts`): when the route's hash names a
 * message, `#message-<id>`, it loads older history if needed, has the virtualizer mount the row and scrolls it under
 * the session title. The Desktop router is a memory router, so `window.location` cannot set that hash; a click on a
 * link can, because the router follows every same-origin link in the page (`@solidjs/router` `data/events.js`).
 *
 * So a jump clicks a hidden link of this plugin whose address is the current route plus the message's hash.
 * `test/jump.test.mjs` checks this against the real router.
 */

/** The id of a user message's row in the page, and the route hash that selects it. */
export const anchorOf = (messageID: string) => `message-${messageID}`

const SCROLLER = '[data-slot="session-timeline-scroll"]'
const ROW = "[data-message-id]"

/** The element that scrolls a row: the nearest ancestor that can scroll. */
function scrollerOf(row: HTMLElement) {
  const view = row.ownerDocument.defaultView

  for (let node = row.parentElement; node && view; node = node.parentElement) {
    const overflow = view.getComputedStyle(node).overflowY

    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node
  }

  return undefined
}

/** Brings a row that is in the page under the session title, as the app's own jump does. */
export function scrollToRow(row: HTMLElement) {
  const root = scrollerOf(row)

  if (!root) return false
  const sticky = root.querySelector("[data-session-title]")
  const inset = sticky instanceof HTMLElement ? sticky.offsetHeight : 0
  const top = row.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - inset
  root.scrollTo({ top: Math.max(0, top), behavior: "auto" })

  return true
}

/**
 * The user message whose turn is at the top of the view. Every row of a turn carries its user message's id, so this
 * also works while the message itself is scrolled out and unmounted. Follows the app's `promptInView`.
 */
export function messageInView(timeline: Element) {
  const scroll = timeline.matches(SCROLLER) ? timeline : timeline.querySelector(SCROLLER)

  if (!scroll) return undefined
  const box = scroll.getBoundingClientRect()
  const line = box.top + 100

  const rows = Array.from(scroll.querySelectorAll<HTMLElement>(ROW)).flatMap((row) => {
    const id = row.dataset.messageId

    if (!id) return []
    const rect = row.getBoundingClientRect()

    return [{ id, top: rect.top, bottom: rect.bottom }]
  })

  const shown = rows.filter((row) => row.bottom > box.top && row.top < box.bottom)
  const hit = shown.find((row) => row.top <= line && row.bottom >= line)

  if (hit) return hit.id

  const near = shown.toSorted((a, b) => Math.abs(a.top - line) - Math.abs(b.top - line) || a.top - b.top)[0]

  return near?.id ?? rows.filter((row) => row.top <= line).at(-1)?.id ?? rows[0]?.id
}

/**
 * @param path - The current route's path with its query, without a hash (`ctx.router.path()`).
 */
export function createJumper(path: () => string) {
  const view = document.defaultView
  const link = document.createElement("a")

  link.setAttribute("data-ocsb-jump", "")
  // The router reads these: replace the history entry, and leave the scrolling to the timeline.
  link.setAttribute("replace", "")
  link.setAttribute("noscroll", "")
  link.tabIndex = -1
  link.hidden = true
  link.setAttribute("aria-hidden", "true")
  document.body.appendChild(link)

  let followed = false
  let last: string | undefined
  let second: ReturnType<typeof setTimeout> | undefined

  // The router answers a link it follows by cancelling the click. One it does not follow would load the address in
  // the window and replace the app, so that is stopped here, after every other listener has seen the click.
  const guard = (event: Event) => {
    if (event.target !== link) return
    followed = event.defaultPrevented

    if (!followed) event.preventDefault()
  }

  view?.addEventListener("click", guard)

  /** Asks the app to go to the message. False when the router did not take the link. */
  const go = (messageID: string) => {
    const route = path()

    if (!route) return false
    followed = false
    link.setAttribute("href", `${route}#${anchorOf(messageID)}`)
    link.click()

    return followed
  }

  const row = (messageID: string) => document.getElementById(anchorOf(messageID))

  return {
    /**
     * @param messageID - The message to bring into view.
     * @param other - Another message of the session, used when the same message is asked for twice.
     */
    jump(messageID: string, other?: string) {
      clearTimeout(second)
      const repeat = last === messageID
      const mounted = row(messageID)

      last = messageID

      // The route may still name this message from the last jump; then the link changes nothing and the app does not
      // move. A row in the page is scrolled to directly. For one that is not, going by way of another message makes
      // the route change.
      if (repeat && !mounted && other && go(other)) {
        second = setTimeout(() => void go(messageID), 80)

        return true
      }

      const taken = go(messageID)

      if ((repeat || !taken) && mounted) return scrollToRow(mounted)

      return taken
    },
    dispose() {
      clearTimeout(second)
      view?.removeEventListener("click", guard)
      link.remove()
    },
  }
}
