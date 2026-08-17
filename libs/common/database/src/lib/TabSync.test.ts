import { createMockStorage } from './test-utils'
import type { StorageEventLike } from './TabSync'
import { attachTabSync, matchesSyncKeys } from './TabSync'

const syncKeys = {
  prefixes: ['artifact_', 'char_', 'team_', 'teamchar_', 'generatedBuildList_'],
  exact: ['db_ver'],
} as const

/** A TabSync attached to a fake storage area, driven synchronously. */
function harness(onSlotChange?: () => void) {
  const area = createMockStorage()
  let reloads = 0
  let emit: (event: Partial<StorageEventLike>) => void = () => {}
  const detach = attachTabSync(
    {
      syncKeys,
      reloadFromStorage: () => {
        reloads++
      },
    },
    {
      slotKey: 'dbIndex',
      storageArea: area,
      onSlotChange,
      schedule: (fn) => {
        fn()
        return () => {}
      },
      subscribe: (handler) => {
        emit = (event) =>
          handler({
            key: null,
            oldValue: null,
            newValue: null,
            storageArea: area,
            ...event,
          })
        return () => {
          emit = () => {}
        }
      },
    }
  )
  return {
    emit: (e: Partial<StorageEventLike>) => emit(e),
    detach,
    area,
    reloads: () => reloads,
  }
}

describe('matchesSyncKeys', () => {
  it('accepts database keys', () => {
    for (const key of ['artifact_5', 'char_Nahida', 'teamchar_2', 'db_ver'])
      expect(matchesSyncKeys(key, syncKeys)).toBe(true)
  })

  it('rejects keys that merely live in the same namespace', () => {
    // GI keys are unprefixed, so this must be an allowlist. `dbMeta` in
    // particular is rewritten on every single mutation - syncing it would turn
    // each keystroke in one tab into a full rebuild in the other.
    for (const key of [
      'dbMeta',
      'display_artifact',
      'num_opt_workers',
      'extraDatabase_3',
      'i18nextLng',
      'GONewTabDetection',
    ])
      expect(matchesSyncKeys(key, syncKeys)).toBe(false)
  })

  it('does not let team_ swallow teamchar_', () => {
    // These stay disjoint only because of the trailing underscore.
    expect('teamchar_1'.startsWith('team_')).toBe(false)
  })
})

describe('attachTabSync', () => {
  it('reloads for an owned key', () => {
    const h = harness()
    h.emit({ key: 'artifact_5', newValue: '{}' })
    expect(h.reloads()).toBe(1)
  })

  it('ignores unowned keys', () => {
    const h = harness()
    h.emit({ key: 'num_opt_workers', newValue: '8' })
    h.emit({ key: 'dbMeta', newValue: '{}' })
    expect(h.reloads()).toBe(0)
  })

  it('reloads on a whole-store clear (key === null)', () => {
    const h = harness()
    h.emit({ key: null })
    expect(h.reloads()).toBe(1)
  })

  it('routes a slot switch to onSlotChange, not a reload', () => {
    let slotChanges = 0
    const h = harness(() => slotChanges++)
    h.emit({ key: 'dbIndex', newValue: '2' })
    // Reloading would be wrong: the active database is now a different slot,
    // so the caller has to re-bootstrap rather than re-read.
    expect(slotChanges).toBe(1)
    expect(h.reloads()).toBe(0)
  })

  it('ignores events from another storage area', () => {
    const h = harness()
    h.emit({ key: 'artifact_5', storageArea: createMockStorage() })
    expect(h.reloads()).toBe(0)
  })

  it('stops reacting once detached', () => {
    const h = harness()
    h.detach()
    h.emit({ key: 'artifact_5', newValue: '{}' })
    expect(h.reloads()).toBe(0)
  })

  it('coalesces a burst into a single reload', () => {
    const area = createMockStorage()
    let reloads = 0
    const pending: (() => void)[] = []
    let emit: (key: string) => void = () => {}
    attachTabSync(
      {
        syncKeys,
        reloadFromStorage: () => {
          reloads++
        },
      },
      {
        slotKey: 'dbIndex',
        storageArea: area,
        // Defer work so the debounce can actually collapse the burst.
        schedule: (fn) => {
          pending.push(fn)
          const index = pending.length - 1
          return () => {
            pending[index] = () => {}
          }
        },
        subscribe: (handler) => {
          emit = (key) =>
            handler({
              key,
              oldValue: null,
              newValue: '{}',
              storageArea: area,
            })
          return () => {}
        },
      }
    )
    emit('artifact_1')
    emit('artifact_2')
    emit('artifact_3')
    pending.forEach((fn) => fn())
    expect(reloads).toBe(1)
  })
})
