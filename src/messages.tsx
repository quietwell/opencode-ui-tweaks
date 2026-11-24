/**
 * Action buttons under the user's messages, in the line under the bubble.
 *
 * Desktop 2.2 drew them under every message: Revert, Fork and Copy on a sent one, Move to queue, Delete and Copy on one
 * that waits to be delivered. Desktop 2.3 moved them all into the message's chevron menu, which only shows while the
 * pointer is over the bubble. This puts both rows back.
 *
 * - A sent message: Revert to here, Fork from here, Copy. Each chooses the item of the app's own menu (`drive.ts`),
 *   so it does exactly what the app does.
 * - A waiting message: Interrupt and send now, Move to queue, Delete, Copy. They make the same server calls as the
 *   app's menu items (`packages/app/src/session/composer/region.tsx`). Interrupt and send now is the plugin's own
 *   addition: it stops the step that is running so the message is delivered at once, instead of at the next step
 *   boundary.
 */
import type { Context } from "@opencode/plugin/gui"
import { createSignal, getOwner, runWithOwner, Show } from "solid-js"
import { render } from "solid-js/web"
import { chooseMessageAction, shownText, type MessageAction } from "./drive"

/** A user message in the timeline (`packages/session-ui/src/message/message-content.tsx`). */
const MESSAGE = '[data-component="user-message"]'

/** The app marks a message that waits to be delivered. */
const WAITING = "data-pending"

/** The line under the bubble. The app shows it while the message waits or the pointer is over the message. */
const FOOTER = ':scope > [data-slot="user-message-copy-wrapper"]'

type Kind = "waiting" | "sent"

type Bar = { kind: Kind; host: HTMLElement; dispose: () => void }

export function createMessageActions(ctx: Context) {
  const owner = getOwner()
  const bars = new Map<Element, Bar>()
  // A row that fails to render is not retried on every change of the page; the app's own menu still has the actions.
  let broken = false

  const kindOf = (message: Element): Kind => (message.hasAttribute(WAITING) ? "waiting" : "sent")

  const drop = (message: Element) => {
    const bar = bars.get(message)

    if (!bar) return
    bars.delete(message)
    bar.dispose()
    bar.host.remove()
  }

  return {
    /** Adds the row to every message on screen, and swaps it when a waiting message is delivered. */
    sync(enabled: boolean) {
      for (const [message, bar] of bars)
        if (!enabled || !message.isConnected || !bar.host.isConnected || bar.kind !== kindOf(message)) drop(message)

      if (!enabled || broken) return

      document.querySelectorAll(MESSAGE).forEach((message) => {
        if (bars.has(message)) return

        const kind = kindOf(message)
        const footer = message.querySelector(FOOTER)
        // The message's text part is `<message id>:text:0`; a message of only attachments carries no id, and the
        // server calls for a waiting message need one.
        const id = message.getAttribute("data-timeline-part-id")?.split(":")[0]

        if (!footer || (kind === "waiting" && !id)) return

        const host = document.createElement("span")
        host.setAttribute(kind === "waiting" ? "data-ocsb-pending" : "data-ocsb-sent", "")

        try {
          const dispose = runWithOwner(owner, () =>
            render(
              () =>
                kind === "waiting" ? (
                  <PendingBar ctx={ctx} messageID={id ?? ""} message={message} />
                ) : (
                  <SentBar ctx={ctx} message={message} />
                ),
              host,
            ),
          )

          if (!dispose) return
          // Last in the line, after the agent and model or "Pending", where the app's own buttons used to be.
          footer.appendChild(host)
          bars.set(message, { kind, host, dispose })
        } catch (cause) {
          broken = true
          host.remove()
          console.error("[opencode-ui-tweaks] the message actions failed to render", cause)
        }
      })
    },
    dispose() {
      for (const message of [...bars.keys()]) drop(message)
    },
  }
}

// A press must not take the focus out of the composer, and a click must not reach the message bubble.
const keep = (event: MouseEvent) => event.preventDefault()

const act = (event: MouseEvent, work: () => unknown) => {
  event.stopPropagation()
  void work()
}

function SentBar(props: { ctx: Context; message: Element }) {
  const ctx = props.ctx
  const ui = ctx.ui
  const [busy, setBusy] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  // A subagent's session has no Revert or Fork in the app either.
  const child = () => {
    try {
      const session = ctx.sessions.current()

      return !!session && !!session.server.data.session.get(session.id)?.parentID
    } catch {
      return false
    }
  }

  const flash = () => {
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }

  const run = async (action: MessageAction) => {
    if (busy()) return
    setBusy(true)

    try {
      const result = await chooseMessageAction(props.message, action)

      if (result === "done" && action === "copy") return flash()

      // Done, switched off by the app for now, or the app's menu is open for the user to choose.
      if (result === "done" || result === "disabled" || result === "shown") return

      if (action === "copy") {
        const text = shownText(props.message)

        if (!text) return
        await ctx.system.copy(text)

        return flash()
      }

      ctx.toast.show({ title: ctx.t("sent.unavailable"), variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  // Plain `title` tooltips: the row renders outside the app's component tree, where its own tooltips may lack context.
  return (
    <span class="ocsb-pending" onMouseDown={keep}>
      <Show when={!child()}>
        <span title={ctx.t("sent.revert")}>
          <ui.IconButton
            icon="reset"
            size="small"
            label={ctx.t("sent.revert")}
            disabled={busy()}
            onClick={(event) => act(event, () => run("revert"))}
          />
        </span>
        <span title={ctx.t("sent.fork")}>
          <ui.IconButton
            icon="fork"
            size="small"
            label={ctx.t("sent.fork")}
            disabled={busy()}
            onClick={(event) => act(event, () => run("fork"))}
          />
        </span>
      </Show>
      <span title={ctx.t(copied() ? "pending.copied" : "pending.copy")}>
        <ui.IconButton
          icon={copied() ? "check" : "copy"}
          size="small"
          label={ctx.t(copied() ? "pending.copied" : "pending.copy")}
          onClick={(event) => act(event, () => run("copy"))}
        />
      </span>
    </span>
  )
}

function PendingBar(props: { ctx: Context; messageID: string; message: Element }) {
  const ctx = props.ctx
  const ui = ctx.ui
  const [busy, setBusy] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  /** The open session whose waiting input this message is, with its server. */
  const locate = () => {
    for (const session of ctx.sessions.list()) {
      try {
        const item = session.server.data.session.pending.list(session.id).find((entry) => entry.id === props.messageID)

        if (item) return { session, item }
      } catch {
        // A server whose data is not readable right now has nothing to offer.
      }
    }

    return undefined
  }

  const run = async (action: "interrupt" | "queue" | "remove") => {
    const found = locate()

    if (!found || busy()) return
    setBusy(true)

    try {
      const session = found.session.server.client.session
      const input = { sessionID: found.session.id, inboxID: props.messageID }

      // `resume` makes the server stop the step that is running and go on at once with the input that waits, instead
      // of at the next step boundary. Finished tool calls are kept; queued prompts stay parked.
      if (action === "interrupt") await session.interrupt({ sessionID: found.session.id, resume: true })
      else if (action === "queue") await session.inbox.update({ ...input, delivery: "queue" })
      else await session.inbox.cancel(input)
    } catch (cause) {
      ctx.toast.show({
        title: ctx.t("error.request"),
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    const item = locate()?.item
    const text = item?.type === "user" ? item.payload.text : shownText(props.message)

    if (!text) return
    await ctx.system.copy(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <span class="ocsb-pending" onMouseDown={keep}>
      <span title={ctx.t("pending.interrupt")}>
        <ui.IconButton
          icon="chevron-double-right"
          size="small"
          label={ctx.t("pending.interrupt")}
          disabled={busy()}
          onClick={(event) => act(event, () => run("interrupt"))}
        />
      </span>
      <span title={ctx.t("pending.queue")}>
        <ui.IconButton
          icon="arrow-down-to-line"
          size="small"
          label={ctx.t("pending.queue")}
          disabled={busy()}
          onClick={(event) => act(event, () => run("queue"))}
        />
      </span>
      <span title={ctx.t("pending.delete")}>
        <ui.IconButton
          icon="outline-trash"
          size="small"
          label={ctx.t("pending.delete")}
          disabled={busy()}
          onClick={(event) => act(event, () => run("remove"))}
        />
      </span>
      <span title={ctx.t(copied() ? "pending.copied" : "pending.copy")}>
        <ui.IconButton
          icon={copied() ? "check" : "copy"}
          size="small"
          label={ctx.t(copied() ? "pending.copied" : "pending.copy")}
          onClick={(event) => act(event, copy)}
        />
      </span>
    </span>
  )
}
