import { act, renderHook } from '@testing-library/react'
import { bootstrapDatabases, useDatabases } from './useDatabases'

/**
 * Fire a `storage` event the way the browser does for a change made in ANOTHER
 * tab. Note the browser never delivers one to the tab that performed the write -
 * that asymmetry is the whole reason `setDatabase` has to re-read `dbIndex`.
 */
function storageEventFromOtherTab(key: string, newValue: string | null) {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      newValue,
      storageArea: localStorage,
    })
  )
}

describe('useDatabases', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts on the slot recorded in localStorage', () => {
    localStorage.setItem('dbIndex', '3')
    const { result } = renderHook(() => useDatabases())
    expect(result.current.database).toBe(result.current.databases[2])
    expect(result.current.database.dbIndex).toBe(3)
  })

  // REGRESSION: `dbIndex` used to be re-read from localStorage on every render.
  // Moving it into `useState` meant the tab that performed a slot swap never
  // refreshed its own index -- `storage` events don't fire in the writing tab --
  // so it kept rendering the previously active slot while localStorage said
  // otherwise. Reloading that tab would then show something different.
  it('follows a slot swap performed in THIS tab', () => {
    localStorage.setItem('dbIndex', '1')
    const { result } = renderHook(() => useDatabases())
    expect(result.current.database.dbIndex).toBe(1)

    const swappedIn = result.current.databases[1]
    act(() => {
      // What `DatabaseCard`'s onSwap does: swapStorage rewrites `dbIndex` as a
      // side effect, then the new database is handed back through setDatabase.
      localStorage.setItem('dbIndex', '2')
      result.current.setDatabase(1, swappedIn)
    })

    expect(result.current.database).toBe(swappedIn)
    expect(result.current.database.dbIndex).toBe(2)
  })

  it('re-bootstraps when ANOTHER tab switches slots', () => {
    localStorage.setItem('dbIndex', '1')
    const { result } = renderHook(() => useDatabases())
    const before = result.current.databases

    act(() => {
      localStorage.setItem('dbIndex', '4')
      storageEventFromOtherTab('dbIndex', '4')
    })

    // A different slot is active now, so re-reading the current database would
    // be wrong - the whole 4-slot bootstrap has to re-run.
    expect(result.current.database.dbIndex).toBe(4)
    expect(result.current.databases).not.toBe(before)
  })

  it('rebuilds in place when another tab edits data, keeping identity stable', async () => {
    localStorage.setItem('dbIndex', '1')
    const { result } = renderHook(() => useDatabases())
    const db = result.current.database
    expect(db.arts.keys.length).toBe(0)

    // Another tab writes an artifact straight to the shared keyspace.
    const art = {
      setKey: 'Instructor',
      rarity: 3,
      level: 0,
      slotKey: 'plume',
      mainStatKey: 'atk',
      substats: [
        { key: 'def_', value: 3.1 },
        { key: '', value: 0 },
        { key: '', value: 0 },
        { key: '', value: 0 },
      ],
      location: '',
      lock: false,
    }
    await act(async () => {
      localStorage.setItem('artifact_0', JSON.stringify(art))
      storageEventFromOtherTab('artifact_0', JSON.stringify(art))
      await new Promise((r) => setTimeout(r, 400))
    })

    expect(db.arts.keys).toContain('artifact_0')
    // Identity must survive: a running optimization closes over this instance.
    expect(result.current.database).toBe(db)
  })

  it('ignores storage keys that are not database entries', async () => {
    localStorage.setItem('dbIndex', '1')
    const { result } = renderHook(() => useDatabases())
    const db = result.current.database
    const spy = vi.spyOn(db, 'reloadFromStorage')

    await act(async () => {
      // `dbMeta` is rewritten on EVERY mutation; syncing it would turn each
      // keystroke in one tab into a full rebuild in the other.
      storageEventFromOtherTab('dbMeta', '{}')
      storageEventFromOtherTab('num_opt_workers', '8')
      storageEventFromOtherTab('extraDatabase_3', '{}')
      await new Promise((r) => setTimeout(r, 400))
    })

    expect(spy).not.toHaveBeenCalled()
  })
})

describe('bootstrapDatabases', () => {
  beforeEach(() => localStorage.clear())

  it('does not rewrite an inactive slot whose contents are unchanged', () => {
    // Every mount used to rewrite all three inactive slots from its own
    // snapshot, which let a newly opened tab resurrect data another tab had
    // just swapped away.
    bootstrapDatabases(1)
    const snapshot = localStorage.getItem('extraDatabase_2')
    expect(snapshot).toBeTruthy()

    const writes: string[] = []
    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string
    ) {
      writes.push(k)
      return realSetItem.call(this, k, v)
    })
    try {
      bootstrapDatabases(1)
    } finally {
      vi.restoreAllMocks()
    }

    expect(writes.filter((k) => k.startsWith('extraDatabase_'))).toEqual([])
    expect(localStorage.getItem('extraDatabase_2')).toBe(snapshot)
  })
})
