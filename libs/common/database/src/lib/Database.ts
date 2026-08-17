import type { DBStorage } from './DBStorage'

export class Database {
  storage: DBStorage
  constructor(storage: DBStorage) {
    this.storage = storage
  }

  /**
   * >0 while the in-memory cache is being rebuilt from a change another tab made.
   *
   * While rebuilding, managers must not write back to storage (the other tab is
   * the author of record) and listener callbacks are deferred until the whole
   * database is consistent again.
   */
  private rebuildDepth = 0
  private flushingRebuild = false
  private deferred: (() => void)[] = []

  get isRebuilding() {
    // Stays true while the deferred callbacks run. Those callbacks *are* part of
    // the rebuild - `updateLastEdit` and friends must still recognize them as
    // another tab's changes, not as local edits worth persisting.
    return this.rebuildDepth > 0 || this.flushingRebuild
  }

  /** Queue a listener flush to run once the outermost `withRebuild` completes. */
  deferTrigger(fn: () => void) {
    this.deferred.push(fn)
  }

  /**
   * Rebuild the cache from storage without echoing writes back out.
   *
   * Listener notifications are deferred to the end so that components never
   * observe a half-rebuilt database (e.g. fresh characters against stale
   * artifacts). Memoized `keys`/`values`/`entries` are still invalidated
   * eagerly by `trigger` — deferring *those* would let `getSnapshot` hand
   * `useSyncExternalStore` a stale frozen array after the flush.
   */
  withRebuild<T>(cb: () => T): T {
    this.rebuildDepth++
    try {
      return cb()
    } finally {
      this.rebuildDepth--
      if (!this.rebuildDepth && !this.flushingRebuild) {
        this.flushingRebuild = true
        try {
          // Drain rather than iterate once: a callback may enqueue more.
          while (this.deferred.length) {
            const queued = this.deferred
            this.deferred = []
            queued.forEach((fn) => fn())
          }
        } finally {
          this.flushingRebuild = false
          this.deferred = []
        }
      }
    }
  }
}
