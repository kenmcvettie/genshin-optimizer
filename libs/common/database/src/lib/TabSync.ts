/**
 * Cross-tab database synchronization.
 *
 * `storage` events fire in every tab *except* the one that wrote, which makes
 * them exactly the signal needed to tell a tab that its in-memory cache is
 * stale. This module owns the single listener and decides what each event means.
 */

/** The subset of `StorageEvent` this module reads. */
export interface StorageEventLike {
  key: string | null
  oldValue: string | null
  newValue: string | null
  storageArea: Storage | null
}

/** Which storage keys belong to a database, and how to rebuild it. */
export interface TabSyncTarget {
  syncKeys: TabSyncKeys
  /** Discard the in-memory cache and re-read everything from storage. */
  reloadFromStorage(): void
}

export interface TabSyncKeys {
  /** Key prefixes owned by this database's data managers. */
  prefixes: readonly string[]
  /** Exact keys that should also force a reload. */
  exact: readonly string[]
}

export interface TabSyncOptions {
  /** Key holding the active database slot (e.g. `dbIndex`). */
  slotKey: string
  /**
   * Called when another tab switched the active slot. A reload is the wrong
   * response there - the active database is now a *different* slot, so the
   * caller has to re-bootstrap rather than re-read.
   */
  onSlotChange?: () => void
  /** Coalescing window; a burst of writes should cause one rebuild. */
  debounceMs?: number
  /** Only react to events from this storage. Defaults to `window.localStorage`. */
  storageArea?: Storage | null
  /** Injectable for tests. Defaults to `window`'s `storage` event. */
  subscribe?: (handler: (event: StorageEventLike) => void) => () => void
  /** Injectable for tests. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void
}

/**
 * Does `key` belong to the database described by `syncKeys`?
 *
 * This is deliberately an allowlist. Database keys share `localStorage` with
 * unrelated ones (`num_opt_workers`, `extraDatabase_*`, i18next, ...) and the GI
 * keys are unprefixed, so a denylist would silently rot as keys are added.
 */
export function matchesSyncKeys(key: string, syncKeys: TabSyncKeys): boolean {
  return (
    syncKeys.exact.includes(key) ||
    syncKeys.prefixes.some((prefix) => key.startsWith(prefix))
  )
}

/**
 * Listen for database changes made by other tabs and rebuild when they happen.
 *
 * @returns a function that detaches the listener and cancels any pending rebuild.
 */
export function attachTabSync(
  target: TabSyncTarget,
  opts: TabSyncOptions
): () => void {
  const {
    slotKey,
    onSlotChange,
    debounceMs = 150,
    storageArea = typeof window === 'undefined' ? null : window.localStorage,
    subscribe = defaultSubscribe,
    schedule = defaultSchedule,
  } = opts

  let cancelPending: (() => void) | undefined

  const scheduleReload = () => {
    cancelPending?.()
    cancelPending = schedule(() => {
      cancelPending = undefined
      target.reloadFromStorage()
    }, debounceMs)
  }

  const handler = (event: StorageEventLike) => {
    // Ignore sessionStorage and any other area we don't own.
    if (storageArea && event.storageArea && event.storageArea !== storageArea)
      return

    // `key === null` means another tab called `storage.clear()`.
    if (event.key === null) return scheduleReload()

    // A slot switch invalidates *which* database we are looking at, not just
    // its contents, so it needs a re-bootstrap rather than a reload.
    if (event.key === slotKey) return onSlotChange?.()

    if (matchesSyncKeys(event.key, target.syncKeys)) scheduleReload()
  }

  const unsubscribe = subscribe(handler)
  return () => {
    cancelPending?.()
    cancelPending = undefined
    unsubscribe()
  }
}

function defaultSubscribe(handler: (event: StorageEventLike) => void) {
  if (typeof window === 'undefined') return () => {}
  const listener = (event: StorageEvent) => handler(event)
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

function defaultSchedule(fn: () => void, ms: number) {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}
