import {
  attachTabSync,
  DBLocalStorage,
  SandboxStorage,
} from '@genshin-optimizer/common/database'
import { ArtCharDatabase } from '@genshin-optimizer/gi/db'
import type { DatabaseContextObj } from '@genshin-optimizer/gi/db-ui'
import { useCallback, useEffect, useMemo, useState } from 'react'

export function readDbIndex() {
  return Number.parseInt(localStorage.getItem('dbIndex') || '1')
}

export function bootstrapDatabases(dbIndex: number) {
  return ([1, 2, 3, 4] as const).map((index) => {
    if (index === dbIndex)
      return new ArtCharDatabase(index, new DBLocalStorage(localStorage))

    const dbName = `extraDatabase_${index}`
    const eDB = localStorage.getItem(dbName)
    const dbObj = eDB ? JSON.parse(eDB) : {}
    const db = new ArtCharDatabase(index, new SandboxStorage(dbObj))
    // Only write back when boot normalization actually changed something.
    // Rewriting unconditionally meant every new tab stomped all three inactive
    // slots with its own snapshot, resurrecting data another tab had swapped away.
    if (eDB === null || db.serializeExtra() !== eDB) db.toExtraLocalDB()
    return db
  })
}

/**
 * Owns the four database slots and which one is active.
 *
 * Both ways the active slot can change have to be handled, and they are not
 * symmetric: `storage` events fire only in *other* tabs, so a swap performed
 * here is invisible to the listener and must be picked up through `setDatabase`.
 */
export function useDatabases(): DatabaseContextObj {
  const [dbIndex, setDbIndex] = useState(readDbIndex)
  const [databases, setDatabases] = useState(() => bootstrapDatabases(dbIndex))

  const setDatabase = useCallback(
    (index: number, db: ArtCharDatabase) => {
      const dbs = [...databases]
      dbs[index] = db
      setDatabases(dbs)
      // A slot swap or database replace performed *in this tab* rewrites
      // `dbIndex`, and `storage` events never fire in the writing tab - so
      // re-read it here or this tab keeps rendering the old active slot.
      setDbIndex(readDbIndex())
    },
    [databases, setDatabases]
  )

  const database = databases[dbIndex - 1]

  // Keep this tab's cache in step with edits made in other tabs.
  useEffect(
    () =>
      attachTabSync(database, {
        slotKey: 'dbIndex',
        // A slot switch changes *which* database is active, so re-reading the
        // current one would be wrong - the whole 4-slot bootstrap has to re-run.
        // KNOWN GAP: a solve running in *this* tab still holds the old database,
        // whose storage now addresses a different slot, so its results would land
        // in the wrong database. Detecting that needs the local `buildStatus` from
        // TabOptimize; the real fix is an exclusive lock around slot switching so
        // it cannot happen while any tab is optimizing.
        onSlotChange: () => {
          const next = readDbIndex()
          setDbIndex(next)
          setDatabases(bootstrapDatabases(next))
        },
      }),
    [database]
  )

  return useMemo(
    () => ({ databases, setDatabases, database, setDatabase }),
    [databases, setDatabases, database, setDatabase]
  )
}
