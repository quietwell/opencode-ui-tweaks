/**
 * Pure logic of the sidebar: the stored state and its edits, a session's status, and how sessions are arranged into
 * groups. No Solid, no DOM and no app imports, so it runs in plain Node tests.
 */

/** A user-created section. */
export type Section = { id: string; name: string; collapsed: boolean }

/** What the plugin stores. `assigned` maps a session key (`<server id>\n<session id>`) to a section id. */
export type State = {
  sections: Section[]
  assigned: Record<string, string>
  collapsed: { recent: boolean; archived: boolean }
  recentExpanded: boolean
  enforceLayout: boolean
  /** Sessions waiting on an approval or an answer show in a group at the top instead of staying in place. */
  attentionOnTop: boolean
  /** Shows the rows of buttons under the user's messages, sent and waiting. */
  pendingActions: boolean
  /** Shows a line per message of the user at the left edge of the timeline, to jump to it. */
  jumpRail: boolean
}

export const initialState: State = {
  sections: [],
  assigned: {},
  collapsed: { recent: false, archived: true },
  recentExpanded: false,
  enforceLayout: true,
  attentionOnTop: true,
  pendingActions: true,
  jumpRail: true,
}

/** The fields of a session the sidebar reads. */
export type SessionLike = {
  id: string
  parentID?: string
  projectID?: string
  title?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { created: number; updated: number; busy?: number; idle?: number; viewed?: number; archived?: number }
  location: { directory: string }
}

/**
 * What a person does next with a session.
 * - `approval`: a permission request waits.
 * - `input`: a question waits.
 * - `working`: a run is in progress.
 * - `failed` / `done`: the last run ended and nobody has looked at it.
 * - `ready`: nothing new.
 */
export type Status = "approval" | "input" | "working" | "failed" | "done" | "ready"

export type Entry = {
  /** `<server id>\n<session id>` */
  key: string
  server: string
  /** Shown on the row when more than one server is listed. */
  serverName?: string
  session: SessionLike
  status: Status
  /** The time the row's age counts from. */
  since: number | undefined
  /** The project's name, or the folder name of the session's directory. */
  project: string
  selected: boolean
}

export const sessionKey = (server: string, sessionID: string) => `${server}\n${sessionID}`

/** The last run ended after the session was last viewed. */
export function isUnread(session: SessionLike) {
  const { idle, viewed } = session.time

  return idle !== undefined && (viewed === undefined || viewed < idle)
}

/** When the current run started; undefined when the last known run already ended. */
export function workingSince(session: SessionLike) {
  const { busy, idle } = session.time

  if (busy === undefined || (idle !== undefined && idle > busy)) return undefined

  return busy
}

export function statusOf(input: { session: SessionLike; permission: boolean; form: boolean; busy: boolean }): Status {
  if (input.permission) return "approval"

  if (input.form) return "input"

  if (input.busy) return "working"

  if (!isUnread(input.session)) return "ready"

  return input.session.outcome === "failed" ? "failed" : "done"
}

export function sinceOf(status: Status, session: SessionLike) {
  if (status === "working" || status === "approval" || status === "input")
    return workingSince(session) ?? session.time.updated

  return session.time.idle ?? session.time.updated
}

/** Untitled sessions carry a generated "New session - <timestamp>" title; show the fallback label for those. */
const GENERATED_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function displayTitle(title: string | undefined, fallback: string) {
  return !title || GENERATED_TITLE.test(title) ? fallback : title
}

export function folderName(directory: string) {
  const parts = directory.split(/[\\/]+/).filter(Boolean)

  return parts[parts.length - 1] ?? directory
}

// --- edits -----------------------------------------------------------------------------------------------------
// Each takes a mutable draft of the state, as `Persisted.update` hands out, and returns nothing the store reads.

export function newSectionID(existing: readonly Section[]) {
  const taken = new Set(existing.map((section) => section.id))

  for (;;) {
    const id = `s${Math.random().toString(36).slice(2, 10)}`

    if (!taken.has(id)) return id
  }
}

/** Names are trimmed and cut to a length that fits the sidebar; an empty name is refused. */
export function cleanName(name: string) {
  const value = name.replace(/\s+/g, " ").trim().slice(0, 60)

  return value || undefined
}

export function addSection(draft: State, name: string, id = newSectionID(draft.sections)) {
  const value = cleanName(name)

  if (!value) return undefined
  draft.sections.push({ id, name: value, collapsed: false })

  return id
}

export function renameSection(draft: State, id: string, name: string) {
  const value = cleanName(name)
  const section = draft.sections.find((item) => item.id === id)

  if (section && value) section.name = value
}

/** Removes the section; its sessions go back to Recent. */
export function deleteSection(draft: State, id: string) {
  draft.sections = draft.sections.filter((section) => section.id !== id)

  for (const key of Object.keys(draft.assigned)) if (draft.assigned[key] === id) delete draft.assigned[key]
}

/** Moves a section up (`-1`) or down (`1`) among the sections. */
export function moveSection(draft: State, id: string, delta: -1 | 1) {
  const from = draft.sections.findIndex((section) => section.id === id)
  const to = from + delta

  if (from === -1 || to < 0 || to >= draft.sections.length) return
  const [section] = draft.sections.splice(from, 1)
  draft.sections.splice(to, 0, section)
}

/** Moves a section to just before or just after another one, as a drag onto that section does. */
export function placeSection(draft: State, id: string, targetID: string, after: boolean) {
  if (id === targetID) return

  const from = draft.sections.findIndex((section) => section.id === id)

  if (from === -1 || !draft.sections.some((section) => section.id === targetID)) return

  const [section] = draft.sections.splice(from, 1)
  const to = draft.sections.findIndex((item) => item.id === targetID)

  draft.sections.splice(after ? to + 1 : to, 0, section)
}

/** Puts a session into a section, or back into Recent with `undefined`. Unknown sections are ignored. */
export function assign(draft: State, key: string, sectionID: string | undefined) {
  if (sectionID === undefined) {
    delete draft.assigned[key]

    return
  }

  if (draft.sections.some((section) => section.id === sectionID)) draft.assigned[key] = sectionID
}

export function toggleSection(draft: State, id: string) {
  const section = draft.sections.find((item) => item.id === id)

  if (section) section.collapsed = !section.collapsed
}

// --- arrangement -----------------------------------------------------------------------------------------------

/** Sessions Recent shows before "Show more". Ones that are open, running, unread or waiting always show. */
export const RECENT_LIMIT = 10

export type Group = {
  /** Every session of the group, in display order. */
  rows: Entry[]
  /** Sessions with a result nobody has looked at. */
  unread: number
  /** Sessions with a run in progress. */
  working: number
  /** Sessions waiting on an approval or an answer; only counted where they stay in place. */
  attention: number
}

export type View = {
  /** Waiting on an approval or an answer, longest wait first. Empty when such sessions stay in place. */
  needs: Entry[]
  sections: (Group & { section: Section })[]
  /** Sessions without a section. `more` says the list was cut at `RECENT_LIMIT`; `total` counts all of them. */
  recent: Group & { more: boolean; total: number }
  archived: Group
}

const waiting = (entry: Entry) => entry.status === "approval" || entry.status === "input"

/**
 * Where a session sorts inside its group: by when its last run ended, else by when it was created. A run in progress
 * changes neither, so a session keeps its place while it works and moves up once the run ends.
 */
export function placeOf(session: SessionLike) {
  return session.time.idle ?? session.time.created
}

const newestFirst = (a: Entry, b: Entry) =>
  placeOf(b.session) - placeOf(a.session) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

const group = (rows: Entry[]): Group => ({
  rows,
  unread: rows.filter((entry) => entry.status === "done" || entry.status === "failed").length,
  working: rows.filter((entry) => entry.status === "working").length,
  attention: rows.filter(waiting).length,
})

/**
 * Sorts sessions into the sidebar's groups. A session is in exactly one group: archived ones in Archived; ones waiting
 * on the user in `needs` (when `attentionOnTop` is on); the rest in their section, or in Recent when they have none or
 * the section no longer exists. A running session stays where it is and only changes its status mark.
 */
export function arrange(entries: readonly Entry[], state: State): View {
  const known = new Set(state.sections.map((section) => section.id))
  const bySection = new Map<string, Entry[]>(state.sections.map((section) => [section.id, []]))
  const needs: Entry[] = []
  const archived: Entry[] = []
  const loose: Entry[] = []

  for (const entry of entries) {
    if (entry.session.time.archived !== undefined) {
      archived.push(entry)
      continue
    }

    if (state.attentionOnTop && waiting(entry)) {
      needs.push(entry)
      continue
    }

    const sectionID = state.assigned[entry.key]

    if (sectionID !== undefined && known.has(sectionID)) bySection.get(sectionID)!.push(entry)
    else loose.push(entry)
  }

  const recent = loose.toSorted(newestFirst)

  // Past the cut, a row stays listed while it is the open session or something on it wants to be seen.
  const shown = state.recentExpanded
    ? recent
    : recent.filter((entry, at) => at < RECENT_LIMIT || entry.selected || entry.status !== "ready")

  return {
    needs: needs.toSorted((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity)),
    sections: state.sections.map((section) => ({
      section,
      ...group(bySection.get(section.id)!.toSorted(newestFirst)),
    })),
    recent: { ...group(shown), more: recent.length > RECENT_LIMIT, total: recent.length },
    archived: group(
      archived.toSorted((a, b) => (b.session.time.archived ?? 0) - (a.session.time.archived ?? 0)),
    ),
  }
}

/** A collapsed group still shows the session that is open, so the current row never disappears. */
export function visibleRows(rows: readonly Entry[], collapsed: boolean) {
  return collapsed ? rows.filter((entry) => entry.selected) : [...rows]
}

/** A short age such as "now", "5m", "3h" or "2d". */
export function shortAge(since: number | undefined, now: number, labels: { now: string }, seconds = false) {
  if (since === undefined) return ""
  const elapsed = Math.max(0, Math.floor((now - since) / 1000))

  if (elapsed < 60) return seconds ? `${elapsed}s` : labels.now

  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`

  if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)}h`

  return `${Math.floor(elapsed / 86_400)}d`
}
