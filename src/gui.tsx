/**
 * opencode-ui-tweaks, Desktop GUI part. It keeps the app on the Inbox layout and shows its own session list in the
 * Inbox sidebar: user-created sections, right-click menus, collapsible groups and a real Archived section.
 *
 * The app evaluates this bundle in its main process too, with placeholders for the window-only modules, so nothing
 * here may touch the DOM outside `setup`.
 */
import { Command, Plugin, SettingsPage, Store, Style, type Context, type Persisted } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { createEffect, createSignal, For, getOwner, onCleanup, runWithOwner, Show, untrack } from "solid-js"
import { render } from "solid-js/web"
import { de, en } from "./i18n"
import { createInbox, type Inbox } from "./inbox"
import { detectLayout, NATIVE_LIST, switchToInbox } from "./layout"
import { SidebarList } from "./list"
import { createMessageActions } from "./messages"
import { addSection, cleanName, deleteSection, initialState, renameSection, type Section, type State } from "./model"
import { createJumpRail } from "./rail"
import css from "./style.css?inline"

const SidebarState = Schema.Struct({
  sections: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, collapsed: Schema.Boolean })),
  assigned: Schema.Record(Schema.String, Schema.String),
  collapsed: Schema.Struct({ recent: Schema.Boolean, archived: Schema.Boolean }),
  recentExpanded: Schema.Boolean,
  enforceLayout: Schema.Boolean,
  attentionOnTop: Schema.Boolean,
  pendingActions: Schema.Boolean,
  // The app fills a field that a stored value lacks from `initialState`, so adding one keeps what is stored.
  jumpRail: Schema.Boolean,
})

type SidebarStore = Persisted<State, State>

export default Plugin.define({
  i18n: { en, de },
  stores: { sidebar: Store.global(SidebarState, initialState) },
  setup(ctx) {
    const store = ctx.stores.sidebar as unknown as SidebarStore
    const owner = getOwner()
    const [active, setActive] = createSignal(false)

    ctx.add(Style, css)

    // --- the list ------------------------------------------------------------------------------------------------

    let inbox: Inbox | undefined
    let mounted: { host: HTMLElement; dispose: () => void } | undefined
    // A list that fails to render is not retried on every DOM change; the built-in list stays.
    let broken = false

    const unmount = () => {
      if (!mounted) return
      const current = mounted
      mounted = undefined
      current.dispose()
      current.host.remove()
    }

    const sync = () => {
      const native = document.querySelector<HTMLElement>(NATIVE_LIST)

      // The app removed or replaced its list, e.g. after a layout change: ours went with it.
      if (mounted && mounted.host.parentElement !== native) unmount()

      // Settings replaces the shell while it is open; only a shell without the Inbox list means the list is off.
      if (!native && detectLayout(document, false) !== "unknown") setActive(false)

      if (!native || mounted || broken) return

      const host = document.createElement("div")
      host.setAttribute("data-ocsb-root", "")

      try {
        const dispose = runWithOwner(owner, () => {
          inbox ??= createInbox(ctx)
          const list = inbox

          return render(() => <SidebarList ctx={ctx} inbox={list} store={store} />, host)
        })

        if (!dispose) return
        // Last in the app's list root: the app's own nodes keep their order, and the stylesheet hides them.
        native.appendChild(host)
        mounted = { host, dispose }
        setActive(true)
      } catch (cause) {
        broken = true
        host.remove()
        console.error("[opencode-ui-tweaks] the session list failed to render", cause)
      }
    }

    // --- actions under the user's messages -----------------------------------------------------------------------

    const pending = createMessageActions(ctx)

    // --- the jump rail -------------------------------------------------------------------------------------------

    const rail = createJumpRail(ctx)

    // The stored switches are read outside a tracking scope, so the next pass picks a change up.
    const syncAll = () => {
      sync()
      pending.sync(untrack(() => store.value.pendingActions))
      rail.sync(untrack(() => store.value.jumpRail))
    }

    // A streaming answer changes the page many times a second; one pass per interval is enough.
    let timer: ReturnType<typeof setTimeout> | undefined

    const observer = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = undefined
        syncAll()
      }, 80)
    })

    // `data-pending` is how the app marks a message that waits; it comes and goes without nodes changing.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-pending"],
    })
    syncAll()

    // Turning a switch off removes its rows or rail at once. Routing to another session shows another timeline, which
    // the app may bring back from its cache by a change of style alone.
    createEffect(() => {
      void store.value.pendingActions
      void store.value.jumpRail
      void ctx.sessions.current()?.key
      untrack(syncAll)

      // The new timeline is on screen a moment after the route names its session.
      const settled = setTimeout(syncAll, 250)

      onCleanup(() => clearTimeout(settled))
    })

    onCleanup(() => {
      observer.disconnect()
      clearTimeout(timer)
      pending.dispose()
      rail.dispose()
      unmount()
    })

    // --- the Inbox layout ----------------------------------------------------------------------------------------

    let attempted = false

    const useInbox = async (manual: boolean) => {
      if (ctx.signal.aborted || ctx.dialogs.active()) return
      const kind = detectLayout(document, ctx.layout.narrow())

      if (kind === "inbox" || (kind === "unknown" && !manual)) return

      // One automatic attempt per window: a switch that did not stick must not reopen Settings in a loop.
      if (!manual) {
        if (attempted) return
        attempted = true
      }

      const switched = await switchToInbox(ctx)

      if (ctx.signal.aborted) return

      if (switched) {
        ctx.toast.show({
          title: ctx.t("layout.switched.title"),
          description: manual ? undefined : ctx.t("layout.switched.description"),
          variant: "success",
        })

        return
      }

      ctx.toast.show({
        title: ctx.t("layout.needed.title"),
        description: ctx.t("layout.needed.description"),
        persistent: true,
        actions: [{ label: ctx.t("layout.needed.action"), run: () => ctx.layout.settings("general") }],
      })
    }

    createEffect(() => {
      if (!ctx.layout.ready() || !store.value.enforceLayout || attempted) return

      // Give the shell a moment to render its sidebar before judging the layout.
      const timer = setTimeout(() => void useInbox(false), 1_500)

      onCleanup(() => clearTimeout(timer))
    })

    // --- commands and settings -----------------------------------------------------------------------------------

    const newSection = async () => {
      const name = await ctx.dialogs.prompt({
        title: ctx.t("prompt.newSection.title"),
        placeholder: ctx.t("prompt.newSection.placeholder"),
        submit: ctx.t("prompt.newSection.submit"),
      })

      if (name !== undefined && cleanName(name)) store.update((draft) => void addSection(draft, name))
    }

    ctx.add(Command, () => ({
      id: "new-section",
      title: ctx.t("command.newSection"),
      keywords: "sidebar section folder group",
      run: () => void newSection(),
    }))

    ctx.add(Command, () => ({
      id: "inbox-layout",
      title: ctx.t("command.inbox"),
      keywords: "sidebar inbox layout interface mode",
      run: () => void useInbox(true),
    }))

    ctx.add(SettingsPage, {
      id: "sidebar",
      icon: "sidebar",
      get title() {
        return ctx.t("settings.title")
      },
      get entries() {
        return [
          { id: "sidebar-enforce", title: ctx.t("settings.enforce.title"), keywords: "inbox layout interface mode" },
          { id: "sidebar-attention", title: ctx.t("settings.attention.title"), keywords: "approval question needs" },
          { id: "sidebar-pending", title: ctx.t("settings.pending.title"), keywords: "revert fork copy queue steer delete interrupt message" },
          { id: "sidebar-rail", title: ctx.t("settings.rail.title"), keywords: "jump rail message navigate minimap" },
          { id: "sidebar-sections", title: ctx.t("settings.sections"), keywords: "section folder group sessions" },
        ]
      },
      render: () => <Settings ctx={ctx} store={store} active={active()} onNewSection={() => void newSection()} />,
    })
  },
})

function Settings(props: { ctx: Context; store: SidebarStore; active: boolean; onNewSection: () => void }) {
  const ctx = props.ctx
  const ui = ctx.ui
  const store = props.store

  const count = (section: Section) =>
    Object.values(store.value.assigned).filter((id) => id === section.id).length

  const rename = async (section: Section) => {
    const name = await ctx.dialogs.prompt({
      title: ctx.t("prompt.renameSection.title"),
      value: section.name,
      submit: ctx.t("prompt.rename.submit"),
    })

    if (name !== undefined) store.update((draft) => void renameSection(draft, section.id, name))
  }

  const remove = async (section: Section) => {
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("confirm.deleteSection.title", { name: section.name }),
      description: ctx.t("confirm.deleteSection.description"),
      confirm: ctx.t("confirm.delete"),
      danger: true,
    })

    if (ok) store.update((draft) => void deleteSection(draft, section.id))
  }

  return (
    <ui.SettingsLayout title={ctx.t("settings.title")} description={ctx.t("settings.description")}>
      <ui.SettingsSection title={ctx.t("settings.layout")}>
        <ui.SettingsRow
          id="sidebar-enforce"
          title={ctx.t("settings.enforce.title")}
          description={ctx.t("settings.enforce.description")}
        >
          <ui.Switch
            label={ctx.t("settings.enforce.title")}
            hideLabel
            checked={store.value.enforceLayout}
            onChange={(next) =>
              store.update((draft) => {
                draft.enforceLayout = next
              })
            }
          />
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title={ctx.t("settings.list")}>
        <ui.SettingsRow
          id="sidebar-attention"
          title={ctx.t("settings.attention.title")}
          description={ctx.t("settings.attention.description")}
        >
          <ui.Switch
            label={ctx.t("settings.attention.title")}
            hideLabel
            checked={store.value.attentionOnTop}
            onChange={(next) =>
              store.update((draft) => {
                draft.attentionOnTop = next
              })
            }
          />
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title={ctx.t("settings.messages")}>
        <ui.SettingsRow
          id="sidebar-pending"
          title={ctx.t("settings.pending.title")}
          description={ctx.t("settings.pending.description")}
        >
          <ui.Switch
            label={ctx.t("settings.pending.title")}
            hideLabel
            checked={store.value.pendingActions}
            onChange={(next) =>
              store.update((draft) => {
                draft.pendingActions = next
              })
            }
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="sidebar-rail"
          title={ctx.t("settings.rail.title")}
          description={ctx.t("settings.rail.description")}
        >
          <ui.Switch
            label={ctx.t("settings.rail.title")}
            hideLabel
            checked={store.value.jumpRail}
            onChange={(next) =>
              store.update((draft) => {
                draft.jumpRail = next
              })
            }
          />
        </ui.SettingsRow>
      </ui.SettingsSection>

      <ui.SettingsSection title={ctx.t("settings.sections")}>
        <Show when={store.value.sections.length === 0}>
          <ui.SettingsRow id="sidebar-sections" title={ctx.t("settings.sections.none")}>
            <ui.Button icon="plus" onClick={props.onNewSection}>
              {ctx.t("prompt.newSection.title")}
            </ui.Button>
          </ui.SettingsRow>
        </Show>
        <For each={store.value.sections}>
          {(section) => (
            <ui.SettingsRow title={section.name} description={ctx.plural("settings.sections.count", count(section))}>
              <ui.Menu
                label={section.name}
                items={[
                  { label: ctx.t("menu.renameSection"), onSelect: () => void rename(section) },
                  { label: ctx.t("menu.deleteSection"), onSelect: () => void remove(section) },
                ]}
              />
            </ui.SettingsRow>
          )}
        </For>
        <Show when={store.value.sections.length > 0}>
          <ui.SettingsRow id="sidebar-sections" title={ctx.t("prompt.newSection.title")}>
            <ui.Button icon="plus" onClick={props.onNewSection}>
              {ctx.t("prompt.newSection.submit")}
            </ui.Button>
          </ui.SettingsRow>
        </Show>
      </ui.SettingsSection>

      <ui.SettingsSection title={ctx.t("settings.status.title")}>
        <ui.SettingsRow title={ctx.t(props.active ? "settings.status.active" : "settings.status.inactive")} />
      </ui.SettingsSection>
    </ui.SettingsLayout>
  )
}
