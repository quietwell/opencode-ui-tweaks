/**
 * Finding the app's Inbox sidebar in the window, and switching the app to the Inbox layout. The plugin API has no
 * hook for either, so both read the app's own markup; every lookup that fails leaves the app as it is.
 */
import type { Context } from "@opencode/plugin/gui"

/** The root of the app's Inbox list (`packages/app/src/shell/titlebar/inbox.tsx`). The plugin's list mounts in it. */
export const NATIVE_LIST = '[data-slot="sidebar-inbox"]'

/** The sidebar the shell renders for the Side tabs and Inbox layouts, open or collapsed. */
const SIDEBAR = '[data-slot="vertical-tabs-sidebar"]'

/** Rendered by the shell in every layout; its absence means the app interface is not on screen. */
const SHELL = '[data-slot="shell-drag-inset"]'

/** The Inbox choice of Settings › General › Interface mode. */
const INBOX_RADIO = '[data-component="interface-mode"] input[type="radio"][value="inbox"]'

/**
 * The interface mode the window shows.
 * - `inbox`: the Inbox list is there.
 * - `side`: the sidebar is there with tabs in it.
 * - `top`: the shell is there without a sidebar.
 * - `unknown`: a narrow window (no sidebar in any mode), or the shell is not on screen.
 */
export type LayoutKind = "inbox" | "side" | "top" | "unknown"

export function detectLayout(root: ParentNode, narrow: boolean): LayoutKind {
  if (root.querySelector(NATIVE_LIST)) return "inbox"

  if (narrow) return "unknown"

  if (root.querySelector(SIDEBAR)) return "side"

  return root.querySelector(SHELL) ? "top" : "unknown"
}

/** Polls until `read` returns something or the time is up. */
export function waitFor<T>(read: () => T | null | undefined, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<T | undefined>((resolve) => {
    const started = Date.now()

    const tick = () => {
      if (signal?.aborted) return resolve(undefined)
      const value = read()

      if (value !== null && value !== undefined) return resolve(value)

      if (Date.now() - started >= timeoutMs) return resolve(undefined)
      setTimeout(tick, 50)
    }

    tick()
  })
}

/**
 * Chooses Inbox in Settings › General › Interface mode, the way a click on it does, then goes back to where the user
 * was. Resolves false when the setting could not be found, e.g. after an app update that moved it.
 */
export async function switchToInbox(ctx: Context): Promise<boolean> {
  const wasInSettings = ctx.router.path().startsWith("/settings")
  const depth = window.history.length

  ctx.layout.settings("general")

  const radio = await waitFor(() => document.querySelector<HTMLInputElement>(INBOX_RADIO), 4_000, ctx.signal)

  if (!radio) return false

  // The app applies the mode in the radio's change handler.
  if (!radio.checked) radio.click()

  const chosen = await waitFor(() => (radio.checked ? true : undefined), 1_000, ctx.signal)

  // Leave Settings only when opening it added a history entry; otherwise the user closes it themself.
  if (!wasInSettings && ctx.router.path().startsWith("/settings") && window.history.length > depth)
    window.history.back()

  return chosen === true
}
