/**
 * The session list the plugin shows in place of the app's Inbox list: Needs attention, the user's sections, Recent
 * and Archived. A running session stays where it is and shows a spinner; nothing moves while it works.
 */
import type { Context, Persisted } from "@opencode/plugin/gui"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import type { Inbox, InboxEntry } from "./inbox"
import { ContextMenu, createMenu, type MenuEntry } from "./menu"
import {
  addSection,
  arrange,
  assign,
  cleanName,
  deleteSection,
  displayTitle,
  moveSection,
  placeSection,
  renameSection,
  shortAge,
  toggleSection,
  visibleRows,
  type Entry,
  type Group,
  type Section,
  type State,
} from "./model"

const SESSION_TYPE = "application/x-opencode-ui-tweaks-session"
const SECTION_TYPE = "application/x-opencode-ui-tweaks-section"

/** What is being dragged: a session row, or a section by its header. */
type Drag = { kind: "session"; key: string } | { kind: "section"; id: string }

export function SidebarList(props: { ctx: Context; inbox: Inbox; store: Persisted<State, State> }) {
  const ctx = props.ctx
  const inbox = props.inbox
  const store = props.store
  const t = (key: string, params?: Record<string, string | number>) => ctx.t(key, params)
  const menu = createMenu()

  const view = createMemo(() => arrange(inbox.entries(), store.value))
  const [drag, setDrag] = createSignal<Drag>()
  // Where a drop would land: `into:<section>` or `into:recent` for a session, `before:`/`after:<section>` for a section.
  const [dropOn, setDropOn] = createSignal<string>()

  const empty = () => !inbox.loading() && inbox.entries().length === 0 && store.value.sections.length === 0

  const endDrag = () => {
    setDrag(undefined)
    setDropOn(undefined)
  }

  // --- actions ---------------------------------------------------------------------------------------------------

  const titleOf = (entry: Entry) => displayTitle(entry.session.title, t("session.untitled"))

  /** Asks for a name and creates the section; `key` puts that session into it. */
  const newSection = async (key?: string) => {
    const name = await ctx.dialogs.prompt({
      title: t("prompt.newSection.title"),
      placeholder: t("prompt.newSection.placeholder"),
      submit: t("prompt.newSection.submit"),
    })

    if (name === undefined || !cleanName(name)) return

    store.update((draft) => {
      const id = addSection(draft, name)

      if (id && key) assign(draft, key, id)
    })
  }

  const askRenameSection = async (section: Section) => {
    const name = await ctx.dialogs.prompt({
      title: t("prompt.renameSection.title"),
      value: section.name,
      submit: t("prompt.rename.submit"),
    })

    if (name !== undefined) store.update((draft) => void renameSection(draft, section.id, name))
  }

  const askDeleteSection = async (section: Section) => {
    const ok = await ctx.dialogs.confirm({
      title: t("confirm.deleteSection.title", { name: section.name }),
      description: t("confirm.deleteSection.description"),
      confirm: t("confirm.delete"),
      danger: true,
    })

    if (ok) store.update((draft) => void deleteSection(draft, section.id))
  }

  const askRenameSession = async (entry: Entry) => {
    const title = await ctx.dialogs.prompt({
      title: t("prompt.renameSession.title"),
      value: titleOf(entry),
      submit: t("prompt.rename.submit"),
    })

    if (title !== undefined) void inbox.rename(entry, title)
  }

  const askDeleteSession = async (entry: Entry) => {
    const ok = await ctx.dialogs.confirm({
      title: t("confirm.deleteSession.title"),
      description: t("confirm.deleteSession.description", { name: titleOf(entry) }),
      confirm: t("confirm.delete"),
      danger: true,
    })

    if (!ok) return
    await inbox.remove(entry)
    store.update((draft) => void assign(draft, entry.key, undefined))
  }

  const setAllCollapsed = (collapsed: boolean) =>
    store.update((draft) => {
      draft.sections.forEach((section) => {
        section.collapsed = collapsed
      })
    })

  // --- menus -----------------------------------------------------------------------------------------------------

  const createEntries = (): MenuEntry[] => [
    { label: t("menu.newSession"), onSelect: () => inbox.newSession() },
    { label: t("menu.newSection"), onSelect: () => void newSection() },
  ]

  const backgroundEntries = (): MenuEntry[] => {
    const sections = store.value.sections

    if (sections.length < 2) return createEntries()
    const allCollapsed = sections.every((section) => section.collapsed)

    return [
      ...createEntries(),
      { type: "separator" },
      {
        label: t(allCollapsed ? "menu.expandAll" : "menu.collapseAll"),
        onSelect: () => setAllCollapsed(!allCollapsed),
      },
    ]
  }

  const sectionEntries = (section: Section): MenuEntry[] => {
    const at = store.value.sections.findIndex((item) => item.id === section.id)

    return [
      ...createEntries(),
      { type: "separator" },
      { label: t("menu.renameSection"), onSelect: () => void askRenameSection(section) },
      {
        label: t("menu.moveUp"),
        disabled: at <= 0,
        onSelect: () => store.update((draft) => void moveSection(draft, section.id, -1)),
      },
      {
        label: t("menu.moveDown"),
        disabled: at === -1 || at >= store.value.sections.length - 1,
        onSelect: () => store.update((draft) => void moveSection(draft, section.id, 1)),
      },
      { type: "separator" },
      { label: t("menu.deleteSection"), danger: true, onSelect: () => void askDeleteSection(section) },
    ]
  }

  const sessionEntries = (entry: Entry): MenuEntry[] => {
    const current = store.value.assigned[entry.key]
    const sections = store.value.sections
    const assigned = current !== undefined && sections.some((section) => section.id === current)
    const archived = entry.session.time.archived !== undefined
    const unread = entry.status === "done" || entry.status === "failed"

    return [
      { type: "label", label: t("menu.moveTo") },
      ...sections.map(
        (section): MenuEntry => ({
          label: section.name,
          checked: section.id === current,
          onSelect: () => store.update((draft) => void assign(draft, entry.key, section.id)),
        }),
      ),
      { label: t("menu.newSection"), checked: false, onSelect: () => void newSection(entry.key) },
      ...(assigned
        ? [
            {
              label: t("menu.removeFromSection"),
              checked: false,
              onSelect: () => store.update((draft) => void assign(draft, entry.key, undefined)),
            } satisfies MenuEntry,
          ]
        : []),
      { type: "separator" },
      { label: t("menu.rename"), onSelect: () => void askRenameSession(entry) },
      ...(unread ? [{ label: t("menu.markRead"), onSelect: () => void inbox.markRead(entry) } satisfies MenuEntry] : []),
      archived
        ? { label: t("menu.unarchive"), onSelect: () => void inbox.unarchive(entry) }
        : { label: t("menu.archive"), onSelect: () => void inbox.archive(entry) },
      { type: "separator" },
      { label: t("menu.delete"), danger: true, onSelect: () => void askDeleteSession(entry) },
    ]
  }

  // --- drag and drop ---------------------------------------------------------------------------------------------

  type DragOver = DragEvent & { currentTarget: HTMLElement }

  /** A section dragged over another lands before it from the upper half and after it from the lower half. */
  const sideOf = (event: DragOver) => {
    const box = event.currentTarget.getBoundingClientRect()

    return event.clientY > box.top + box.height / 2 ? "after" : "before"
  }

  const leave = (event: DragOver, clear: (value: string | undefined) => boolean) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return

    if (clear(dropOn())) setDropOn(undefined)
  }

  // Called once per group; the accessors are read where the group renders, so only its attributes follow the drag.
  const sectionZone = (id: string) => ({
    into: () => (dropOn() === `into:${id}` ? "" : undefined),
    edge: () => (dropOn() === `before:${id}` ? "before" : dropOn() === `after:${id}` ? "after" : undefined),
    onDragOver: (event: DragOver) => {
      const current = drag()

      if (!current || (current.kind === "section" && current.id === id)) return
      event.preventDefault()

      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      setDropOn(current.kind === "session" ? `into:${id}` : `${sideOf(event)}:${id}`)
    },
    onDragLeave: (event: DragOver) => leave(event, (value) => !!value?.endsWith(`:${id}`)),
    onDrop: (event: DragOver) => {
      const current = drag()

      if (!current) return
      event.preventDefault()
      const side = sideOf(event)

      endDrag()

      store.update((draft) => {
        if (current.kind === "section") return void placeSection(draft, current.id, id, side === "after")

        assign(draft, current.key, id)
        // Show where the session went.
        const section = draft.sections.find((item) => item.id === id)

        if (section) section.collapsed = false
      })
    },
  })

  const recentZone = {
    into: () => (dropOn() === "into:recent" ? "" : undefined),
    onDragOver: (event: DragOver) => {
      if (drag()?.kind !== "session") return
      event.preventDefault()

      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      setDropOn("into:recent")
    },
    onDragLeave: (event: DragOver) => leave(event, (value) => value === "into:recent"),
    onDrop: (event: DragOver) => {
      const current = drag()

      if (current?.kind !== "session") return
      event.preventDefault()
      endDrag()
      store.update((draft) => void assign(draft, current.key, undefined))
    },
  }

  const startDrag = (event: DragEvent, value: Drag) => {
    if (event.dataTransfer) {
      event.dataTransfer.setData(
        value.kind === "session" ? SESSION_TYPE : SECTION_TYPE,
        value.kind === "session" ? value.key : value.id,
      )
      event.dataTransfer.effectAllowed = "move"
    }

    setDrag(value)
  }

  // --- rows ------------------------------------------------------------------------------------------------------

  const draggedKey = () => {
    const current = drag()

    return current?.kind === "session" ? current.key : undefined
  }

  // Rows render from their key and read the live entry, so a session update changes a row in place.
  const rows = (list: () => readonly Entry[]) => (
    <For each={list().map((entry) => entry.key)}>
      {(key) => (
        <Show when={inbox.byKey().get(key)}>
          {(entry) => (
            <Row
              ctx={ctx}
              entry={entry()}
              title={titleOf(entry())}
              now={inbox.now()}
              dragging={draggedKey() === key}
              onOpen={() => inbox.open(entry())}
              onMenu={(event) => menu.open(event, sessionEntries(entry()))}
              onDragStart={(event) => startDrag(event, { kind: "session", key })}
              onDragEnd={endDrag}
            />
          )}
        </Show>
      )}
    </For>
  )

  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return

    const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-ocsb-stop]"))
    const index = stops.findIndex((item) => item === event.target)

    if (index === -1) return

    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? stops.length - 1
          : event.key === "ArrowUp"
            ? Math.max(0, index - 1)
            : Math.min(stops.length - 1, index + 1)

    event.preventDefault()
    // The app's own list handles the same keys on its root; this event is ours.
    event.stopPropagation()
    stops[next]?.focus({ preventScroll: true })
    stops[next]?.scrollIntoView?.({ block: "nearest" })
  }

  return (
    <div class="ocsb-list" onKeyDown={onKeyDown} aria-busy={inbox.loading()}>
      <div class="ocsb-scroll" data-scrollable onContextMenu={(event) => menu.open(event, backgroundEntries())}>
        <Show when={inbox.loading() && inbox.entries().length === 0}>
          <div class="ocsb-note" role="status">
            {t("list.loading")}
          </div>
        </Show>

        <Show when={view().needs.length > 0}>
          <section class="ocsb-group" data-group="needs">
            <GroupHead ctx={ctx} label={t("group.needs")} count={view().needs.length} tone="warning" />
            <div class="ocsb-rows">{rows(() => view().needs)}</div>
          </section>
        </Show>

        <For each={store.value.sections.map((section) => section.id)}>
          {(id) => {
            const item = () => view().sections.find((entry) => entry.section.id === id)
            const zone = sectionZone(id)

            const dragged = () => {
              const current = drag()

              return current?.kind === "section" && current.id === id ? "" : undefined
            }

            return (
              <Show when={item()}>
                {(group) => (
                  <section
                    class="ocsb-group"
                    data-group="section"
                    data-drop={zone.into()}
                    data-drop-edge={zone.edge()}
                    data-dragging={dragged()}
                    onDragOver={zone.onDragOver}
                    onDragLeave={zone.onDragLeave}
                    onDrop={zone.onDrop}
                  >
                    <GroupHead
                      ctx={ctx}
                      label={group().section.name}
                      count={group().rows.length}
                      marks={group().section.collapsed ? group() : undefined}
                      collapsed={group().section.collapsed}
                      onToggle={() => store.update((draft) => void toggleSection(draft, id))}
                      onMenu={(event) => menu.open(event, sectionEntries(group().section))}
                      onDragStart={(event) => startDrag(event, { kind: "section", id })}
                      onDragEnd={endDrag}
                    />
                    <div class="ocsb-rows">
                      {rows(() => visibleRows(group().rows, group().section.collapsed))}
                      <Show when={!group().section.collapsed && group().rows.length === 0}>
                        <div class="ocsb-note">{t("section.empty")}</div>
                      </Show>
                    </div>
                  </section>
                )}
              </Show>
            )
          }}
        </For>

        <Show when={view().recent.total > 0 || drag()?.kind === "session"}>
          <section
            class="ocsb-group"
            data-group="recent"
            data-drop={recentZone.into()}
            onDragOver={recentZone.onDragOver}
            onDragLeave={recentZone.onDragLeave}
            onDrop={recentZone.onDrop}
          >
            <GroupHead
              ctx={ctx}
              label={t("group.recent")}
              count={view().recent.total}
              marks={store.value.collapsed.recent ? view().recent : undefined}
              collapsed={store.value.collapsed.recent}
              onToggle={() =>
                store.update((draft) => {
                  draft.collapsed.recent = !draft.collapsed.recent
                })
              }
              onMenu={(event) => menu.open(event, backgroundEntries())}
            />
            <div class="ocsb-rows">
              {rows(() => visibleRows(view().recent.rows, store.value.collapsed.recent))}
              <Show when={!store.value.collapsed.recent && view().recent.more}>
                <button
                  type="button"
                  class="ocsb-more"
                  data-ocsb-stop
                  aria-expanded={store.value.recentExpanded}
                  onClick={() =>
                    store.update((draft) => {
                      draft.recentExpanded = !draft.recentExpanded
                    })
                  }
                >
                  {t(store.value.recentExpanded ? "recent.less" : "recent.more")}
                </button>
              </Show>
            </div>
          </section>
        </Show>

        <Show when={view().archived.rows.length > 0}>
          <section class="ocsb-group" data-group="archived">
            <GroupHead
              ctx={ctx}
              label={t("group.archived")}
              count={view().archived.rows.length}
              collapsed={store.value.collapsed.archived}
              onToggle={() =>
                store.update((draft) => {
                  draft.collapsed.archived = !draft.collapsed.archived
                })
              }
              onMenu={(event) => menu.open(event, backgroundEntries())}
            />
            <div class="ocsb-rows">
              {rows(() => visibleRows(view().archived.rows, store.value.collapsed.archived))}
            </div>
          </section>
        </Show>

        <Show when={empty()}>
          <div class="ocsb-note">{t("list.empty")}</div>
        </Show>
      </div>

      <ContextMenu menu={menu} />
    </div>
  )
}

function GroupHead(props: {
  ctx: Context
  label: string
  count?: number
  /** What a collapsed group hides: a spinner for a run, a dot for an unviewed result or a waiting request. */
  marks?: Pick<Group, "unread" | "working" | "attention">
  tone?: "warning"
  collapsed?: boolean
  onToggle?: () => void
  onMenu?: (event: MouseEvent) => void
  /** Makes the header the handle that drags its section. */
  onDragStart?: (event: DragEvent) => void
  onDragEnd?: () => void
}) {
  const content = (): JSX.Element => (
    <>
      <span class="ocsb-head-label" dir="auto">
        {props.label}
      </span>
      <Show when={props.count}>
        <span class="ocsb-head-count">{props.count}</span>
      </Show>
      <Show when={props.marks?.attention}>
        <span class="ocsb-status" data-status="approval" aria-hidden="true" />
      </Show>
      <Show when={props.marks?.working}>
        <span class="ocsb-status" data-status="working" aria-hidden="true" />
      </Show>
      <Show when={props.marks?.unread}>
        <span class="ocsb-status" data-status="done" aria-hidden="true" />
      </Show>
    </>
  )

  return (
    <Show
      when={props.onToggle}
      fallback={
        <div class="ocsb-head" data-tone={props.tone} onContextMenu={(event) => props.onMenu?.(event)}>
          {content()}
        </div>
      }
    >
      {(toggle) => (
        <button
          type="button"
          class="ocsb-head"
          data-ocsb-stop
          data-collapsed={props.collapsed ? "" : undefined}
          aria-expanded={!props.collapsed}
          draggable={!!props.onDragStart}
          onClick={() => toggle()()}
          onContextMenu={(event) => props.onMenu?.(event)}
          onDragStart={(event) => props.onDragStart?.(event)}
          onDragEnd={() => props.onDragEnd?.()}
        >
          <span class="ocsb-chevron" aria-hidden="true">
            <props.ctx.ui.Icon name="fill-triangle-down" size="small" />
          </span>
          {content()}
        </button>
      )}
    </Show>
  )
}

function Row(props: {
  ctx: Context
  entry: InboxEntry
  title: string
  now: number
  dragging: boolean
  onOpen: () => void
  onMenu: (event: MouseEvent) => void
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
}) {
  const status = () => props.entry.status
  const archived = () => props.entry.session.time.archived !== undefined

  const age = () =>
    shortAge(props.entry.since, props.now, { now: props.ctx.t("time.now") }, status() === "working")

  return (
    <button
      type="button"
      class="ocsb-row"
      data-ocsb-stop
      data-ocsb-session={props.entry.key}
      data-status={status()}
      data-state={props.entry.selected ? "active" : undefined}
      data-archived={archived() ? "" : undefined}
      data-dragging={props.dragging ? "" : undefined}
      aria-current={props.entry.selected ? "page" : undefined}
      title={`${props.title}\n${props.entry.session.location.directory}`}
      draggable={!archived()}
      onClick={props.onOpen}
      onContextMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
    >
      <span class="ocsb-row-title" dir="auto">
        {props.title}
      </span>
      <span class="ocsb-row-sub">
        <span class="ocsb-row-project" dir="auto">
          {props.entry.project}
          <Show when={props.entry.serverName}>{(name) => <> · {name()}</>}</Show>
        </span>
        <span class="ocsb-row-end">
          <Show when={status() !== "ready"}>
            <span
              class="ocsb-status"
              data-status={status()}
              role="img"
              aria-label={props.ctx.t(`status.${status()}`)}
            />
          </Show>
          <span class="ocsb-row-age">{age()}</span>
        </span>
      </span>
    </button>
  )
}
