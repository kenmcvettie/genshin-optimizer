import { deepFreeze } from '@genshin-optimizer/common/util'
import type { TriggerString } from './common'
import type { Database } from './Database'

export class DataManagerBase<
  CacheKey extends string,
  DataKey extends string,
  CacheValue extends StorageValue,
  StorageValue,
  DatabaseType extends Database,
> {
  database: DatabaseType
  /**
   * The "list name" when an DataManagerBase is exported to GO data
   */
  dataKey: DataKey

  constructor(database: DatabaseType, goKey: DataKey) {
    this.database = database
    this.dataKey = goKey
  }

  data: Partial<Record<CacheKey, CacheValue>> = {}
  listeners: Partial<Record<CacheKey, DataManagerCallback<CacheKey>[]>> = {}
  anyListeners: DataManagerCallback<CacheKey>[] = []

  toStorageKey(key: CacheKey): string {
    return key
  }
  toCacheKey(key: string): CacheKey {
    return key as CacheKey
  }
  /**
   * Populate the cache by scanning storage. Subclasses override this with the
   * prefix scan that used to live inline in their constructors.
   *
   * Callers rebuilding a whole database must `resetCache()` *every* manager
   * before scanning any of them - see {@link resetCache}.
   */
  scanStorage(): void {
    // no entries by default
  }
  /**
   * Drop the cache without re-reading it.
   *
   * Split from the scan because `toCache` implementations may read *sibling*
   * managers (a character derives `equippedArtifacts` from the artifact cache).
   * Resetting and scanning one manager at a time would let a not-yet-rebuilt
   * sibling's stale entries leak into the new cache.
   */
  resetCache(): void {
    this.data = {}
    // `trigger` only clears these for new/remove/update, and a rebuild's triggers
    // are deferred - so drop them up front rather than relying on that.
    this.cachedKeys = undefined
    this.cachedValues = undefined
    this.cachedEntries = undefined
  }
  /**
   * Discard the cache and re-scan it from storage.
   *
   * Only safe for a lone manager, or inside `database.withRebuild`, which
   * suppresses the storage writes the scan's normalization would otherwise echo
   * back to other tabs.
   */
  loadFromStorage(): void {
    this.resetCache()
    this.scanStorage()
  }
  validate(obj: unknown, _key: CacheKey): StorageValue | undefined {
    return obj as StorageValue
  }
  toCache(storageObj: StorageValue, id: CacheKey): CacheValue | undefined {
    return { ...storageObj, id } as CacheValue
  }
  deCache(cacheObj: CacheValue): StorageValue {
    const { id, ...storageObj } = cacheObj as any
    return storageObj
  }
  followAny(callback: DataManagerCallback<CacheKey>): () => void {
    this.anyListeners.push(callback)
    return () => {
      this.anyListeners = this.anyListeners.filter((cb) => cb !== callback)
    }
  }
  follow(key: CacheKey, callback: DataManagerCallback<CacheKey>) {
    if (!key) return () => {}
    if (this.listeners[key]) this.listeners[key]?.push(callback)
    else this.listeners[key] = [callback]
    return () => {
      this.listeners[key] = this.listeners[key]?.filter((cb) => cb !== callback)
      if (!this.listeners[key]?.length) delete this.listeners[key]
    }
  }
  // Caching and freezing keys, values and entries to be immutable references for useSyncExternalStore
  cachedKeys: readonly CacheKey[] | undefined = undefined
  get keys() {
    if (!this.cachedKeys)
      this.cachedKeys = Object.freeze(
        Object.keys(this.data)
      ) as readonly CacheKey[]
    return this.cachedKeys
  }
  cachedValues: readonly CacheValue[] | undefined = undefined
  get values() {
    if (!this.cachedValues)
      this.cachedValues = Object.freeze(
        Object.values(this.data)
      ) as readonly CacheValue[]
    return this.cachedValues
  }
  cachedEntries: readonly [CacheKey, CacheValue][] | undefined = undefined
  get entries() {
    if (!this.cachedEntries)
      this.cachedEntries = Object.freeze(
        Object.entries(this.data)
      ) as readonly [CacheKey, CacheValue][]
    return this.cachedEntries
  }
  get(key: CacheKey | '' | undefined): CacheValue | undefined {
    return key ? this.data[key] : undefined
  }
  getStorage(key: CacheKey): StorageValue {
    return this.database.storage.get(this.toStorageKey(key))
  }
  set(
    key: CacheKey,
    valueOrFunc:
      | Partial<StorageValue>
      | ((v: StorageValue) => Partial<StorageValue> | void | false),
    notify = true
  ): boolean {
    const old = this.getStorage(key)
    if (typeof valueOrFunc === 'function' && !old) {
      this.trigger(key, 'invalid', valueOrFunc)
      return false
    }
    const value =
      typeof valueOrFunc === 'function'
        ? (valueOrFunc(old) ?? old)
        : valueOrFunc
    if (value === false) return false
    const validated = this.validate({ ...(old ?? {}), ...value }, key)
    if (!validated) {
      this.trigger(key, 'invalid', value)
      return false
    }
    const cached = this.toCache(validated, key)
    if (!cached) {
      this.trigger(key, 'invalid', value)
      return false
    }
    this.setCached(key, cached)
    if (!old && notify) this.trigger(key, 'new', cached)
    return true
  }
  setCached(key: CacheKey, cached: CacheValue) {
    deepFreeze(cached)
    this.data[key] = cached
    this.saveStorageEntry(key, cached)
    this.trigger(key, 'update', cached)
  }
  /** Trigger update event */
  trigger(key: CacheKey, reason: TriggerString, object?: any) {
    // Invalidate memoized views eagerly, even mid-rebuild: a rebuild is one
    // synchronous block, so nothing can read them before it finishes, and
    // deferring would leave `useSyncExternalStore` holding a stale snapshot.
    if (reason === 'new' || reason === 'remove') {
      this.cachedKeys = undefined
      this.cachedValues = undefined
      this.cachedEntries = undefined
    }
    if (reason === 'update') {
      this.cachedValues = undefined
      this.cachedEntries = undefined
    }
    const fire = () => {
      this.listeners[key]?.forEach((cb) => cb(key, reason, object))
      this.anyListeners.forEach((cb) => cb(key, reason, object))
    }
    if (this.database.isRebuilding) this.database.deferTrigger(fire)
    else fire()
  }
  remove(key: CacheKey, notify = true) {
    const rem = this.data[key]
    if (!rem) return rem
    delete this.data[key]
    this.removeStorageEntry(key)

    if (notify) this.trigger(key, 'remove', rem)
    delete this.listeners[key]
    return rem
  }
  /**
   * change the id of the entry in `oldKey` to a `newKey`.
   * Will fail if
   *   oldKey == newKey
   *   data[oldKey] doesnt exist
   *   data[newKey] exists
   *   setting data[newKey] fails.
   * @param oldKey
   * @param newKey
   * @param notify
   * @returns
   */
  changeId(oldKey: CacheKey, newKey: CacheKey, notify = false): boolean {
    if (oldKey === newKey) return false
    const value = this.get(oldKey)
    if (!value) return false
    if (this.get(newKey)) return false
    if (!this.set(newKey, value, notify)) return false
    this.remove(oldKey, notify)
    return true
  }
  get goKeySingle() {
    if (this.dataKey.endsWith('s')) return this.dataKey.slice(0, -1)
    return this.dataKey
  }
  generateKey(keys: Set<string> = new Set(this.keys)): string {
    let ind = keys.size
    let candidate = ''
    do {
      candidate = `${this.goKeySingle}_${ind++}`
    } while (
      keys.has(candidate) ||
      // Another tab may have claimed this id without our cache knowing. Probe via
      // `getString`, not `get` - `get` parses and *deletes* keys it can't parse.
      this.database.storage.getString(
        this.toStorageKey(candidate as CacheKey)
      ) !== undefined
    )
    return candidate
  }

  clear() {
    for (const key in this.data) {
      this.remove(key)
    }
  }
  removeStorageEntry(key: CacheKey) {
    // During a rebuild the other tab owns storage; echoing writes back would
    // ping-pong between tabs and can undo what that tab just decided.
    if (this.database.isRebuilding) return
    this.database.storage.remove(this.toStorageKey(key))
  }
  saveStorageEntry(key: CacheKey, cached: CacheValue) {
    if (this.database.isRebuilding) return
    this.database.storage.set(this.toStorageKey(key), this.deCache(cached))
  }
  clearStorage() {
    for (const key in this.data) this.removeStorageEntry(key)
  }
  saveStorage() {
    Object.entries(this.data).forEach(([k, v]) =>
      this.saveStorageEntry(k as CacheKey, v as CacheValue)
    )
  }
}
export type DataManagerCallback<Arg> = (
  key: Arg,
  reason: TriggerString,
  object: any
) => void
