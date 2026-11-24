/**
 * A jump rail for the routed session: one short line per message the user sent, at the left edge of the timeline,
 * centred in its height. A line grows and brightens under the pointer and shows the start of its message; a click
 * goes to that message. The line of the message being read is marked.
 *
 * The plugin API has no place in the timeline to render into, so the rail mounts in the element the app keeps over
 * the visible part of the timeline, the one above the composer (`packages/app/src/session/timeline/virtualizer.tsx`).
 * Without that element there is no rail.
 */
import type { Context } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, For, getOwner, on, onCleanup, runWithOwner, Show } from "solid-js"
import { render } from "solid-js/web"
import { createJumper, messageInView } from "./jump"

/** The app's box over the visible part of a timeline. It takes no pointer input itself. */
const AREA = '[data-slot="session-timeline-visible"]'

/** A session with fewer messages has nowhere to jump. */
const MIN_MESSAGES = 2

const PREVIEW_LENGTH = 220

type Mounted = { area: Element; host: HTMLElement; dispose: () => void }

export function createJumpRail(ctx: Context) {
  const owner = getOwner()
  let mounted: Mounted | undefined
  // A rail that fails to render is not retried on every change of the page.
  let broken = false

  const unmount = () => {
    if (!mounted) return
    const current = mounted
    mounted = undefined
    current.dispose()
    current.host.remove()
  }

  // A session kept in the background keeps its timeline, out of the page or without a box.
  const shown = (area: Element) => area.isConnected && area.getClientRects().length > 0

  return {
    /** Puts the rail in the timeline that is on screen, and takes it out of one that no longer is. */
    sync(enabled: boolean) {
      const area = enabled ? Array.from(document.querySelectorAll(AREA)).find(shown) : undefined

      if (mounted && (mounted.area !== area || !mounted.host.isConnected)) unmount()

      if (!area || mounted || broken) return

      const host = document.createElement("div")
      host.setAttribute("data-ocsb-rail", "")

      try {
        const dispose = runWithOwner(owner, () => render(() => <Rail ctx={ctx} area={area} />, host))

        if (!dispose) return
        area.appendChild(host)
        mounted = { area, host, dispose }
      } catch (cause) {
        broken = true
        host.remove()
        console.error("[opencode-ui-tweaks] the jump rail failed to render", cause)
      }
    },
    dispose: unmount,
  }
}

function Rail(props: { ctx: Context; area: Element }) {
  const ctx = props.ctx
  const jumper = createJumper(() => ctx.router.path())
  const [active, setActive] = createSignal<string>()
  const [hover, setHover] = createSignal<{ id: string; top: number }>()
  let root: HTMLDivElement | undefined
  let list: HTMLDivElement | undefined

  onCleanup(jumper.dispose)

  /** The routed session's own messages, oldest first, without the ones a revert hides. */
  const messages = createMemo(() => {
    try {
      const session = ctx.sessions.current()

      if (!session) return []
      const data = session.server.data.session
      const reverted = data.get(session.id)?.revert?.messageID

      return data.message
        .list(session.id)
        .flatMap((message) =>
          message.type === "user" && (!reverted || message.id < reverted) ? [{ id: message.id, text: message.text }] : [],
        )
    } catch {
      // A server whose data is not readable right now has nothing to list.
      return []
    }
  })

  // Ids are stable while a reply streams, so the lines are not rebuilt then.
  const ids = createMemo(() => messages().map((message) => message.id), [] as string[], {
    equals: (a, b) => a.length === b.length && a.every((id, at) => id === b[at]),
  })

  const preview = (id: string) => {
    const text = (messages().find((message) => message.id === id)?.text ?? "").replace(/\s+/g, " ").trim()

    if (!text) return ctx.t("rail.noText")

    return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text
  }

  // --- the message being read --------------------------------------------------------------------------------------

  const timeline = () => props.area.parentElement
  let frame: number | undefined

  const locate = () => {
    frame = undefined
    const view = timeline()
    const id = view ? messageInView(view) : undefined

    // A turn of a message this rail does not list, e.g. one a revert hides, leaves the mark where it was.
    if (id && ids().includes(id)) setActive(id)
  }

  const schedule = () => {
    frame ??= requestAnimationFrame(locate)
  }

  // Scroll events do not bubble; capturing on the document sees the timeline's without knowing which element scrolls.
  const onScroll = (event: Event) => {
    const view = timeline()

    if (view && event.target instanceof Node && view.contains(event.target)) schedule()
  }

  document.addEventListener("scroll", onScroll, true)
  onCleanup(() => {
    document.removeEventListener("scroll", onScroll, true)

    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  createEffect(on(ids, schedule))

  // A long session's lines scroll inside the rail; the marked one stays in sight.
  createEffect(() => {
    const id = active()
    const line = id && list ? Array.from(list.children).find((item) => item.getAttribute("data-id") === id) : undefined

    if (!(line instanceof HTMLElement) || !list) return
    const top = line.offsetTop
    const bottom = top + line.offsetHeight

    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  })

  // --- pointer -----------------------------------------------------------------------------------------------------

  const jump = (id: string) => {
    const all = ids()
    const at = all.indexOf(id)

    setActive(id)
    jumper.jump(id, all[at + 1] ?? all[at - 1])
  }

  const enter = (id: string, line: HTMLElement) => {
    if (!root) return
    const box = line.getBoundingClientRect()

    setHover({ id, top: box.top + box.height / 2 - root.getBoundingClientRect().top })
  }

  return (
    <Show when={!ctx.layout.narrow() && ids().length >= MIN_MESSAGES}>
      <div
        ref={root}
        class="ocsb-rail"
        role="navigation"
        aria-label={ctx.t("rail.label")}
        onMouseLeave={() => setHover(undefined)}
        // A press must not take the focus out of the composer.
        onMouseDown={(event) => event.preventDefault()}
      >
        <div ref={list} class="ocsb-rail-list">
          <For each={ids()}>
            {(id) => (
              <button
                type="button"
                class="ocsb-rail-item"
                tabIndex={-1}
                data-id={id}
                data-active={active() === id ? "" : undefined}
                aria-current={active() === id ? "true" : undefined}
                aria-label={preview(id)}
                onMouseEnter={(event) => enter(id, event.currentTarget)}
                onClick={(event) => {
                  event.stopPropagation()
                  jump(id)
                }}
              >
                <span class="ocsb-rail-line" />
              </button>
            )}
          </For>
        </div>
        <Show when={hover()}>
          {(at) => (
            <div class="ocsb-rail-tip" style={{ top: `${at().top}px` }}>
              <span class="ocsb-rail-tip-count">
                {ids().indexOf(at().id) + 1}/{ids().length}
              </span>
              <span class="ocsb-rail-tip-text">{preview(at().id)}</span>
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}
