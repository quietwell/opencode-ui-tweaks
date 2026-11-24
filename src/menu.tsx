/**
 * A right-click menu at the pointer. The app's own context menu is not part of the plugin UI kit, so this one is the
 * plugin's; it carries the app's menu attributes so the app's menu styles apply, and style.css fills in the rest.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

export type MenuEntry =
  | {
      type?: "item"
      label: string
      /** Shows a check before the label, for the current choice of a list. `false` keeps the column empty. */
      checked?: boolean
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { type: "separator" }
  | { type: "label"; label: string }

export type MenuRequest = { x: number; y: number; entries: MenuEntry[] }

/** One menu at a time: `open` replaces what is shown, `close` hides it. */
export function createMenu() {
  const [request, setRequest] = createSignal<MenuRequest>()

  return {
    request,
    open(event: MouseEvent, entries: MenuEntry[]) {
      event.preventDefault()
      event.stopPropagation()
      setRequest(entries.length ? { x: event.clientX, y: event.clientY, entries } : undefined)
    },
    close: () => setRequest(undefined),
  }
}

export type MenuController = ReturnType<typeof createMenu>

export function ContextMenu(props: { menu: MenuController }) {
  return (
    <Show when={props.menu.request()} keyed>
      {(request) => <MenuView request={request} close={props.menu.close} />}
    </Show>
  )
}

function MenuView(props: { request: MenuRequest; close: () => void }) {
  let element: HTMLDivElement | undefined

  const [position, setPosition] = createSignal({ left: props.request.x, top: props.request.y })

  const items = () => Array.from(element?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])

  onMount(() => {
    if (!element) return
    const node = element

    // On the body, so a transformed sidebar (its peek) does not offset the fixed position.
    document.body.appendChild(node)
    onCleanup(() => node.remove())

    // Keep the menu inside the window.
    const box = element.getBoundingClientRect()
    const margin = 8

    setPosition({
      left: Math.max(margin, Math.min(props.request.x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(props.request.y, window.innerHeight - box.height - margin)),
    })
    items()[0]?.focus({ preventScroll: true })

    const outside = (event: Event) => {
      if (event.target instanceof Node && element?.contains(event.target)) return
      props.close()
    }

    // Capture phase, so a click elsewhere closes the menu even when its target stops the event.
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("contextmenu", outside, true)
    window.addEventListener("blur", props.close)
    window.addEventListener("resize", props.close)
    document.addEventListener("scroll", outside, true)

    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("contextmenu", outside, true)
      window.removeEventListener("blur", props.close)
      window.removeEventListener("resize", props.close)
      document.removeEventListener("scroll", outside, true)
    })
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      props.close()

      return
    }

    const list = items()
    const index = list.findIndex((item) => item === document.activeElement)
    let next = index

    if (event.key === "ArrowDown") next = index === -1 ? 0 : (index + 1) % list.length
    else if (event.key === "ArrowUp") next = index <= 0 ? list.length - 1 : index - 1
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = list.length - 1
    else return

    event.preventDefault()
    event.stopPropagation()
    list[next]?.focus({ preventScroll: true })
  }

  // Built here and attached in `onMount`; the component itself renders nothing in place.
  void (
      <div
        ref={element}
        role="menu"
        class="ocsb-menu"
        data-component="menu-v2-content"
        data-ocsb-menu
        style={{ left: `${position().left}px`, top: `${position().top}px` }}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        <For each={props.request.entries}>
          {(entry) => {
            if (entry.type === "separator") return <div role="separator" data-slot="menu-v2-separator" />

            if (entry.type === "label")
              return (
                <div data-slot="menu-v2-group-label" class="ocsb-menu-label">
                  {entry.label}
                </div>
              )

            return (
              <button
                type="button"
                role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={entry.checked}
                class="ocsb-menu-item"
                data-component="menu-v2-item"
                data-variant={entry.danger ? "critical" : undefined}
                disabled={entry.disabled}
                onClick={() => {
                  props.close()
                  entry.onSelect()
                }}
                onPointerMove={(event) => event.currentTarget.focus({ preventScroll: true })}
              >
                <Show when={entry.checked !== undefined}>
                  <span class="ocsb-menu-check" aria-hidden="true">
                    {entry.checked ? "✓" : ""}
                  </span>
                </Show>
                <span data-slot="menu-v2-item-content" class="ocsb-menu-text">
                  {entry.label}
                </span>
              </button>
            )
          }}
        </For>
      </div>
  )

  return undefined
}
