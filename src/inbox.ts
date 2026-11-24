/**
 * The sessions the sidebar lists: root sessions of every server the app lists, each with the state a person acts on.
 * It reads the same sources as the app's own Inbox: one fetched page of recent sessions per server, the newest
 * archived ones, and the app's live session data on top.
 */
import type { SessionInfo } from "@opencode/client/promise"
import type { Context, ServerRef } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { folderName, sessionKey, sinceOf, statusOf, type Entry } from "./model"

/** Root sessions fetched per server, as the app's Inbox does. */
const INDEX_LIMIT = 50
const ARCHIVED_LIMIT = 50

/** Server events after which the fetched pages may be out of date. */
const RELOAD_EVENTS =
  /^session\.(created|deleted|archived|unarchived|forked|moved|renamed|idle|viewed|execution\.(started|succeeded|failed|interrupted))$/

/** Forms that wait for a person, as the app counts them. */
const QUESTION_KINDS = new Set(["question", "websearch.provider", "mcp-elicitation"])

type Index = { active: SessionInfo[]; archived: SessionInfo[] }

/** The app's internals can differ between versions; a read that throws counts as "nothing there". */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read() ?? fallback
  } catch {
    return fallback
  }
}

export type InboxEntry = Entry & { session: SessionInfo }

export function createInbox(ctx: Context) {
  const [index, setIndex] = createStore<Record<string, Index | undefined>>({})

  // Changes this window made that the fetched pages and the live data may not show yet. `null` means unarchived.
  const [local, setLocal] = createStore<{
    archived: Record<string, number | null | undefined>
    removed: Record<string, true | undefined>
    titles: Record<string, string | undefined>
  }>({ archived: {}, removed: {}, titles: {} })

  const [loaded, setLoaded] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const refs = createMemo(() =>
    ctx.servers.list().flatMap((id) => {
      const ref = ctx.servers.get(id)

      return ref ? [ref] : []
    }),
  )

  const loading = new Set<string>()
  // Servers that changed while their pages were being fetched: that answer may predate the change.
  const stale = new Set<string>()

  // A store setter merges objects, so entries are cleared one by one.
  const forgetLocal = (kind: "archived" | "titles", server: string) => {
    const prefix = `${server}\n`

    for (const key of Object.keys(local[kind])) if (key.startsWith(prefix)) setLocal(kind, key, undefined)
  }

  const load = async (ref: ServerRef) => {
    if (!ref.connected) return

    if (loading.has(ref.id)) {
      stale.add(ref.id)

      return
    }

    loading.add(ref.id)

    try {
      const client = ref.client

      const [active, archived] = await Promise.all([
        client.session.list({ limit: INDEX_LIMIT, order: "desc", parentID: null, archived: false }),
        client.session.list({ limit: ARCHIVED_LIMIT, order: "desc", parentID: null, archived: true }),
      ])

      if (ctx.signal.aborted) return
      setIndex(ref.id, { active: [...active.data], archived: [...archived.data] })

      // The server's answer is newer than anything this window assumed, unless something changed meanwhile.
      if (!stale.has(ref.id)) {
        forgetLocal("archived", ref.id)
        forgetLocal("titles", ref.id)
      }
    } catch {
      // A server that fails to answer keeps what it listed before; the next event or tick tries again.
    } finally {
      loading.delete(ref.id)
      setLoaded(true)

      if (stale.delete(ref.id) && !ctx.signal.aborted) reloadSoon(ref)
    }
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function reloadSoon(ref: ServerRef) {
    if (loading.has(ref.id)) stale.add(ref.id)
    clearTimeout(timers.get(ref.id))
    timers.set(
      ref.id,
      setTimeout(() => void load(ref), 400),
    )
  }

  createEffect(() => {
    refs().forEach((ref) => {
      if (!ref.connected) return
      untrack(() => void load(ref))

      const stop = safe(
        () =>
          ref.data.listen((event) => {
            if (event.name === "session.deleted") {
              const id = (event.details as { data?: { sessionID?: string } }).data?.sessionID

              if (id) setLocal("removed", sessionKey(ref.id, id), true)
            }

            if (RELOAD_EVENTS.test(event.name)) reloadSoon(ref)
          }),
        () => undefined,
      )

      onCleanup(stop)
    })
  })

  // No server connects when none is listed; do not hold the first paint for that.
  const settle = setTimeout(() => setLoaded(true), 3_000)
  const refresh = setInterval(() => refs().forEach((ref) => void load(ref)), 60_000)

  onCleanup(() => {
    clearTimeout(settle)
    clearInterval(refresh)
    timers.forEach(clearTimeout)
  })

  const selectedKey = createMemo(() => {
    const current = ctx.sessions.current()

    if (!current) return undefined
    const root = safe(() => current.server.data.session.root(current.id), current.id)

    return sessionKey(current.server.id, root || current.id)
  })

  const entries = createMemo((): InboxEntry[] => {
    const servers = refs()
    const selected = selectedKey()

    return servers.flatMap((ref) => {
      const data = ref.data
      const slot = index[ref.id]
      const live = safe(() => data.session.list(), [] as SessionInfo[])
      const byID = new Map<string, SessionInfo>()

      // Sessions the app has loaded come last, so their live title and times win over the fetched pages.
      for (const session of slot?.active ?? []) byID.set(session.id, session)
      for (const session of slot?.archived ?? []) byID.set(session.id, session)
      for (const session of live) byID.set(session.id, session)

      // A root session counts as working while any session of its family runs.
      const busyRoots = new Set<string>()

      for (const id of new Set([...live.map((session) => session.id), ...safe(() => data.session.active(), [])]))
        if (busy(ref, id)) busyRoots.add(safe(() => data.session.root(id), id))

      return [...byID.values()].flatMap((raw): InboxEntry[] => {
        const key = sessionKey(ref.id, raw.id)

        if (raw.parentID || local.removed[key]) return []

        const archived = local.archived[key]
        const title = local.titles[key]

        const session: SessionInfo =
          archived === undefined && title === undefined
            ? raw
            : {
                ...raw,
                title: title ?? raw.title,
                time: { ...raw.time, archived: archived === undefined ? raw.time.archived : (archived ?? undefined) },
              }

        const family = [raw.id, ...safe(() => data.session.family(raw.id), [] as string[])]

        const status = statusOf({
          session,
          permission: family.some((id) => safe(() => data.session.permission.list(id).length > 0, false)),
          form: family.some((id) =>
            safe(
              () =>
                (data.session.form.list(id) ?? []).some((form) =>
                  QUESTION_KINDS.has(String((form.metadata as { kind?: unknown } | undefined)?.kind)),
                ),
              false,
            ),
          ),
          busy: busyRoots.has(raw.id),
        })

        return [
          {
            key,
            server: ref.id,
            serverName: servers.length > 1 ? ref.name : undefined,
            session,
            status,
            since: sinceOf(status, session),
            project:
              safe(() => data.project.get(session.projectID)?.name, undefined) ||
              folderName(session.location.directory),
            selected: key === selected,
          },
        ]
      })
    })
  })

  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])))
  const refOf = (entry: Entry) => ctx.servers.get(entry.server)

  // Requests and the end of a run only reach the app for sessions it has loaded, so load every working root once.
  const synced = new Set<string>()

  createEffect(() => {
    entries().forEach((entry) => {
      if (entry.status !== "working") {
        synced.delete(entry.key)

        return
      }

      if (synced.has(entry.key)) return
      synced.add(entry.key)
      const data = refOf(entry)?.data

      if (!data) return
      const id = entry.session.id

      void Promise.allSettled([
        Promise.resolve().then(() => (safe(() => data.session.get(id), undefined) ? undefined : data.session.sync(id))),
        Promise.resolve().then(() => data.session.permission.sync(id)),
        Promise.resolve().then(() => data.session.form.sync(id)),
      ])
    })
  })

  // Ages tick every second only while something runs.
  const hasWorking = createMemo(() => entries().some((entry) => entry.status === "working"))

  createEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), hasWorking() ? 1_000 : 30_000)

    onCleanup(() => clearInterval(interval))
  })

  const failed = (cause: unknown) =>
    ctx.toast.show({
      title: ctx.t("error.request"),
      description: cause instanceof Error ? cause.message : String(cause),
      variant: "error",
    })

  /** Closes the session's tab, as the app does for a session that leaves the list. */
  const closeTab = (entry: Entry) => {
    ctx.tabs
      .list()
      .filter((tab) => tab.session?.id === entry.session.id && tab.session.server.id === entry.server)
      .forEach((tab) => ctx.tabs.close(tab.key))
  }

  const setArchived = (entry: Entry, archived: boolean) => {
    const ref = refOf(entry)

    if (!ref) return Promise.resolve()

    return ref.client.session
      .update({ sessionID: entry.session.id, archived })
      .then(() => {
        setLocal("archived", entry.key, archived ? Date.now() : null)

        if (archived) closeTab(entry)
        reloadSoon(ref)
      })
      .catch(failed)
  }

  return {
    entries,
    byKey,
    now,
    /** Nothing has been listed yet: the list would still claim it is empty. */
    loading: () => !loaded(),
    open(entry: Entry) {
      ctx.tabs.open({ server: entry.server, id: entry.session.id }, { focus: true })
    },
    newSession() {
      if (!ctx.commands.run("session.new")) ctx.commands.run("tab.new")
    },
    rename(entry: Entry, title: string) {
      const ref = refOf(entry)
      const value = title.trim()

      if (!ref || !value) return Promise.resolve()

      return ref.client.session
        .update({ sessionID: entry.session.id, title: value })
        .then(() => {
          setLocal("titles", entry.key, value)
          reloadSoon(ref)
        })
        .catch(failed)
    },
    archive: (entry: Entry) => setArchived(entry, true),
    unarchive: (entry: Entry) => setArchived(entry, false),
    markRead(entry: Entry) {
      const ref = refOf(entry)
      const idle = entry.session.time.idle

      if (!ref || idle === undefined) return Promise.resolve()

      return ref.client.session
        .view({ sessionID: entry.session.id, idle })
        .then(() => reloadSoon(ref))
        .catch(failed)
    },
    remove(entry: Entry) {
      const ref = refOf(entry)

      if (!ref) return Promise.resolve()

      return ref.client.session
        .remove({ sessionID: entry.session.id })
        .then(() => {
          setLocal("removed", entry.key, true)
          closeTab(entry)
          reloadSoon(ref)
        })
        .catch(failed)
    },
  }
}

export type Inbox = ReturnType<typeof createInbox>

function busy(ref: ServerRef, id: string) {
  const data = ref.data

  return (
    safe(() => data.session.status(id) === "running", false) ||
    safe(() => data.session.pending.list(id).some((item) => item.type !== "synthetic"), false)
  )
}
