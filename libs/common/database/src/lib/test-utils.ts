import { DBLocalStorage } from './DBLocalStorage'
import type { StorageType } from './DBStorage'
import { SandboxStorage } from './SandboxStorage'

/**
 * Create a mock localStorage for testing.
 *
 * IMPORTANT: the stored entries must be the mock's own *enumerable* properties,
 * because `DBLocalStorage.keys`/`entries` are `Object.keys`/`Object.entries` over
 * the `Storage` object itself. A plain object literal with the methods declared
 * inline would enumerate `getItem`, `setItem`, ... instead of the stored keys,
 * which silently makes every `DataManager` constructor scan find nothing.
 */
export function createMockStorage(): Storage {
  const store = {} as Record<string, string> & Storage
  const hidden = (value: unknown) => ({
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.defineProperties(store, {
    getItem: hidden((key: string) => store[key] ?? null),
    setItem: hidden((key: string, value: string) => {
      store[key] = String(value)
    }),
    removeItem: hidden((key: string) => {
      delete store[key]
    }),
    clear: hidden(() => {
      for (const key of Object.keys(store)) delete store[key]
    }),
    key: hidden((index: number) => Object.keys(store)[index] ?? null),
    length: {
      get: () => Object.keys(store).length,
      enumerable: false,
      configurable: false,
    },
  })
  return store
}

/**
 * Create a DBLocalStorage for testing with isolated storage
 */
export function createTestDBStorage(storageType: StorageType = 'go') {
  const mockStorage = createMockStorage()
  return new DBLocalStorage(mockStorage, storageType)
}

/**
 * Create a SandboxStorage for testing (in-memory only)
 */
export function createTestSandboxStorage() {
  return new SandboxStorage()
}

/** The subset of `StorageEvent` that {@link attachTabSync} actually reads. */
export interface SyntheticStorageEvent {
  key: string | null
  oldValue: string | null
  newValue: string | null
  storageArea: Storage | null
}

export interface StorageBusTab {
  /** Pass this to `new DBLocalStorage(...)` / a `Database` subclass. */
  raw: Storage
  storage: DBLocalStorage
  /** Register the handler that would normally be `window.addEventListener('storage')`. */
  listen(handler: (event: SyntheticStorageEvent) => void): void
  /** Deliver every event queued for this tab since the last flush. */
  flushEvents(): void
  /** Number of events waiting for this tab. */
  pending(): number
}

/**
 * Simulate N browser tabs sharing one `localStorage`.
 *
 * Every tab reads and writes the same backing store, and a write made through one
 * tab queues a `storage` event for all the *others* — never for the writer, which
 * matches real `StorageEvent` semantics and is the whole reason cross-tab sync is
 * hard to get right.
 */
export function createSharedStorageBus(storageType: StorageType = 'go') {
  const backing: Record<string, string> = {}
  const tabs: {
    raw: Storage
    queue: SyntheticStorageEvent[]
    handler?: (event: SyntheticStorageEvent) => void
  }[] = []

  function makeRaw(self: () => (typeof tabs)[number]): Storage {
    const fire = (
      key: string | null,
      oldValue: string | null,
      newValue: string | null
    ) => {
      const me = self()
      for (const tab of tabs)
        if (tab !== me)
          tab.queue.push({ key, oldValue, newValue, storageArea: tab.raw })
    }
    const methods: Record<string, unknown> = {
      getItem: (key: string) => backing[key] ?? null,
      setItem: (key: string, value: string) => {
        const oldValue = backing[key] ?? null
        backing[key] = String(value)
        if (oldValue !== backing[key]) fire(key, oldValue, backing[key])
      },
      removeItem: (key: string) => {
        if (!(key in backing)) return
        const oldValue = backing[key]
        delete backing[key]
        fire(key, oldValue, null)
      },
      clear: () => {
        for (const key of Object.keys(backing)) delete backing[key]
        fire(null, null, null)
      },
      key: (index: number) => Object.keys(backing)[index] ?? null,
    }
    // A Proxy, so `Object.keys`/`Object.entries` see the stored entries (as they
    // do on a real Storage) while the methods stay reachable but non-enumerable.
    return new Proxy(backing, {
      get: (target, prop, recv) =>
        prop === 'length'
          ? Object.keys(backing).length
          : prop in methods
            ? methods[prop as string]
            : Reflect.get(target, prop, recv),
      has: (target, prop) =>
        prop === 'length' || prop in methods || Reflect.has(target, prop),
    }) as unknown as Storage
  }

  function createTab(): StorageBusTab {
    const tab: (typeof tabs)[number] = { raw: null as any, queue: [] }
    tab.raw = makeRaw(() => tab)
    tabs.push(tab)
    return {
      raw: tab.raw,
      storage: new DBLocalStorage(tab.raw, storageType),
      listen: (handler) => {
        tab.handler = handler
      },
      flushEvents: () => {
        const queued = tab.queue
        tab.queue = []
        queued.forEach((event) => tab.handler?.(event))
      },
      pending: () => tab.queue.length,
    }
  }

  return { createTab, backing, snapshot: () => JSON.stringify(backing) }
}
