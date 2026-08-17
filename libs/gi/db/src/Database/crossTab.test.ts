import type { StorageEventLike } from '@genshin-optimizer/common/database'
import {
  attachTabSync,
  createMockStorage,
  createSharedStorageBus,
  DBLocalStorage,
} from '@genshin-optimizer/common/database'
import { randomizeArtifact } from '@genshin-optimizer/gi/util'
import { ArtCharDatabase } from './ArtCharDatabase'

/** Two ArtCharDatabases over one shared "localStorage", as two tabs would be. */
function twoTabs() {
  const bus = createSharedStorageBus('go')
  const tabA = bus.createTab()
  const tabB = bus.createTab()
  const a = new ArtCharDatabase(1, tabA.storage)
  const b = new ArtCharDatabase(1, tabB.storage)
  // Both tabs listen, symmetrically - there is no leader. Debouncing is disabled
  // so `flushEvents()` rebuilds synchronously.
  tabA.listen((event) => attachSyncOnce(a, event, tabA.raw))
  tabB.listen((event) => attachSyncOnce(b, event, tabB.raw))
  return { bus, tabA, tabB, a, b }
}

/** Run the router's decision for a single event, without timers. */
function attachSyncOnce(
  db: ArtCharDatabase,
  event: StorageEventLike,
  storageArea: Storage
) {
  let unsub = () => {}
  const detach = attachTabSync(db, {
    slotKey: 'dbIndex',
    storageArea,
    debounceMs: 0,
    schedule: (fn) => {
      fn()
      return () => {}
    },
    subscribe: (handler) => {
      unsub = () => {}
      handler(event)
      return unsub
    },
  })
  detach()
}

describe('createMockStorage', () => {
  it('enumerates stored entries, not its own methods', () => {
    // Regression guard: the previous object-literal mock made `Object.keys`
    // return method names, so every DataManager constructor scan found nothing
    // and every test that relied on one passed vacuously.
    const raw = createMockStorage()
    raw.setItem('artifact_1', '{}')
    raw.setItem('char_Nahida', '{}')
    expect(Object.keys(raw).sort()).toEqual(['artifact_1', 'char_Nahida'])
    expect(new DBLocalStorage(raw).keys.sort()).toEqual([
      'artifact_1',
      'char_Nahida',
    ])
    expect(raw.length).toBe(2)
    expect(raw.getItem('artifact_1')).toBe('{}')
  })
})

describe('cross-tab sync', () => {
  it('picks up an artifact another tab created, and writes nothing back', () => {
    const { bus, tabA, tabB, a, b } = twoTabs()
    expect(b.arts.keys.length).toBe(0)

    a.arts.new(randomizeArtifact({ level: 0 }))
    const [artId] = a.arts.keys
    expect(artId).toBeTruthy()

    const before = bus.snapshot()
    tabB.flushEvents()

    expect(b.arts.keys).toContain(artId)
    expect(b.arts.get(artId)?.level).toBe(0)
    // The rebuild must not echo anything back to storage.
    expect(bus.snapshot()).toBe(before)
    expect(tabA.pending()).toBe(0)
  })

  it('drops records the other tab deleted', () => {
    const { tabB, a, b } = twoTabs()
    a.arts.new(randomizeArtifact({ level: 0 }))
    const [artId] = a.arts.keys
    tabB.flushEvents()
    expect(b.arts.keys).toContain(artId)

    a.arts.remove(artId)
    tabB.flushEvents()
    expect(b.arts.keys).not.toContain(artId)
  })

  it('agrees with storage after an artifact is moved between characters', () => {
    // This is the case the whole coarse-rebuild design exists for:
    // `ArtifactDataManager.toCache` re-derives equipment relations, and it does
    // so from the *local* previous value. Patching one remote key in isolation
    // would let this tab compute a different fixup than the authoring tab did.
    const { bus, tabA, tabB, a, b } = twoTabs()
    a.chars.getWithInitWeapon('Nahida')
    a.chars.getWithInitWeapon('Nilou')
    a.arts.new(randomizeArtifact({ level: 0, slotKey: 'flower' }))
    const [artId] = a.arts.keys

    a.arts.set(artId, { location: 'Nahida' })
    tabB.flushEvents()
    expect(b.arts.get(artId)?.location).toBe('Nahida')
    expect(b.chars.get('Nahida')?.equippedArtifacts.flower).toBe(artId)

    a.arts.set(artId, { location: 'Nilou' })
    tabA.flushEvents()
    const stored = bus.snapshot()
    tabB.flushEvents()

    // B must land on exactly the relations A persisted, and must not rewrite
    // anything while getting there.
    expect(b.arts.get(artId)?.location).toBe('Nilou')
    expect(b.chars.get('Nilou')?.equippedArtifacts.flower).toBe(artId)
    expect(b.chars.get('Nahida')?.equippedArtifacts.flower).toBe('')
    expect(bus.snapshot()).toBe(stored)
  })

  it('defers listener notifications until the rebuild is consistent', () => {
    const { tabB, a, b } = twoTabs()
    a.arts.new(randomizeArtifact({ level: 0 }))

    const seen: number[] = []
    b.arts.followAny(() => seen.push(b.arts.keys.length))
    tabB.flushEvents()

    // Every callback must observe the finished rebuild, never a partial one.
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set([a.arts.keys.length]))
  })

  it('adopts the authoring tab lastEdit instead of stamping its own', () => {
    const { bus, tabA, tabB, a, b } = twoTabs()
    a.arts.new(randomizeArtifact({ level: 0 }))
    tabA.flushEvents()

    const storedDbMeta = bus.backing['dbMeta']
    tabB.flushEvents()

    // B must mirror A's stamp, and must not have written a fresh one - a
    // self-stamp here would bounce a dbMeta event back and amplify every edit.
    expect(b.dbMeta.get().lastEdit).toBe(a.dbMeta.get().lastEdit)
    expect(bus.backing['dbMeta']).toBe(storedDbMeta)
    expect(tabA.pending()).toBe(0)
  })
})

describe('generateKey across tabs', () => {
  it('does not reuse an id another tab already claimed', () => {
    const { tabA, a, b } = twoTabs()
    // B is deliberately never flushed, so its cache stays unaware of A's write.
    const idA = a.generatedBuildList.new({ builds: [], buildDate: 1 })
    const idB = b.generatedBuildList.new({ builds: [], buildDate: 2 })

    expect(idA).toBeTruthy()
    expect(idB).not.toBe(idA)
    expect(tabA.storage.get(idA)).toBeTruthy()
    expect(tabA.storage.get(idB)).toBeTruthy()
  })
})

describe('concurrent optimization results', () => {
  // The load-bearing case: two tabs finishing optimizations on *different*
  // optConfigs must produce two independent build lists.
  it.each([
    ['A then B', false],
    ['B then A', true],
  ])('keeps both results (%s)', (_label, reversed) => {
    const { tabA, tabB, a, b } = twoTabs()

    const optA = a.optConfigs.new()
    tabB.flushEvents()
    const optB = b.optConfigs.new()
    tabA.flushEvents()
    expect(optA).not.toBe(optB)

    const saveA = () =>
      a.optConfigs.newOrSetGeneratedBuildList(optA, {
        builds: [],
        buildDate: 111,
      })
    const saveB = () =>
      b.optConfigs.newOrSetGeneratedBuildList(optB, {
        builds: [],
        buildDate: 222,
      })
    if (reversed) {
      saveB()
      saveA()
    } else {
      saveA()
      saveB()
    }

    tabA.flushEvents()
    tabB.flushEvents()

    const listA = a.optConfigs.get(optA)?.generatedBuildListId
    const listB = a.optConfigs.get(optB)?.generatedBuildListId
    expect(listA).toBeTruthy()
    expect(listB).toBeTruthy()
    expect(listA).not.toBe(listB)
    expect(a.generatedBuildList.get(listA!)?.buildDate).toBe(111)
    expect(a.generatedBuildList.get(listB!)?.buildDate).toBe(222)
  })

  it('leaves no orphan when both tabs target the same optConfig', () => {
    const { tabA, tabB, a, b } = twoTabs()
    const optId = a.optConfigs.new()
    tabB.flushEvents()

    a.optConfigs.newOrSetGeneratedBuildList(optId, {
      builds: [],
      buildDate: 111,
    })
    // B never saw A's write - without the storage read-through it would mint a
    // second list here and strand A's forever.
    b.optConfigs.newOrSetGeneratedBuildList(optId, {
      builds: [],
      buildDate: 222,
    })

    tabA.flushEvents()
    expect(a.generatedBuildList.keys.length).toBe(1)
    expect(a.optConfigs.get(optId)?.generatedBuildListId).toBe(
      a.generatedBuildList.keys[0]
    )
  })
})
