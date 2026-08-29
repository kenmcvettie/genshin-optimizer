import type { DBStorage } from '@genshin-optimizer/common/database'
import { Database, SandboxStorage } from '@genshin-optimizer/common/database'
import { compressToB64Gzip } from '@genshin-optimizer/common/util'
import type { GenderKey } from '@genshin-optimizer/gi/consts'
import type { IGOOD } from '@genshin-optimizer/gi/good'
import { DBMetaEntry } from './DataEntries/DBMetaEntry'
import { DisplayArchiveEntry } from './DataEntries/DisplayArchiveEntry'
import { DisplayArtifactEntry } from './DataEntries/DisplayArtifactEntry'
import { DisplayCharacterEntry } from './DataEntries/DisplayCharacterEntry'
import { DisplayTeamEntry } from './DataEntries/DisplayTeamEntry'
import { DisplayToolEntry } from './DataEntries/DisplayTool'
import { DisplayWeaponEntry } from './DataEntries/DisplayWeaponEntry'
import { ArtifactDataManager } from './DataManagers/ArtifactDataManager'
import { BuildDataManager } from './DataManagers/BuildDataManager'
import { BuildTcDataManager } from './DataManagers/BuildTcDataManager'
import { CharacterDataManager } from './DataManagers/CharacterDataManager'
import { CharMetaDataManager } from './DataManagers/CharMetaDataManager'
import { GeneratedBuildListDataManager } from './DataManagers/GeneratedBuildListDataManager'
import { OptConfigDataManager } from './DataManagers/OptConfigDataManager'
import { TeamCharacterDataManager } from './DataManagers/TeamCharacterDataManager'
import { TeamDataManager } from './DataManagers/TeamDataManager'
import { WeaponDataManager } from './DataManagers/WeaponDataManager'
import type { IGO, ImportResult } from './exim'
import { GOSource, newImportResult } from './exim'
import { currentDBVersion, migrate, migrateGOOD } from './migrate'
export class ArtCharDatabase extends Database {
  arts: ArtifactDataManager
  chars: CharacterDataManager
  buildTcs: BuildTcDataManager
  weapons: WeaponDataManager
  optConfigs: OptConfigDataManager
  generatedBuildList: GeneratedBuildListDataManager
  charMeta: CharMetaDataManager
  builds: BuildDataManager
  teamChars: TeamCharacterDataManager
  teams: TeamDataManager

  dbMeta: DBMetaEntry
  displayWeapon: DisplayWeaponEntry
  displayArtifact: DisplayArtifactEntry
  displayCharacter: DisplayCharacterEntry
  displayArchive: DisplayArchiveEntry
  displayTool: DisplayToolEntry
  displayTeam: DisplayTeamEntry
  dbIndex: 1 | 2 | 3 | 4
  dbVer: number

  constructor(dbIndex: 1 | 2 | 3 | 4, storage: DBStorage) {
    super(storage)
    migrate(storage)
    // Transfer non DataManager/DataEntry data from storage
    this.dbIndex = dbIndex
    this.dbVer = storage.getDBVersion()
    this.storage.setDBVersion(this.dbVer)
    this.storage.setDBIndex(this.dbIndex)

    // Handle Datamanagers
    this.chars = new CharacterDataManager(this)

    // Weapons needs to be instantiated after character to check for relations
    this.weapons = new WeaponDataManager(this)

    // Artifacts needs to be instantiated after character to check for relations
    this.arts = new ArtifactDataManager(this)

    this.weapons.ensureEquipments()

    // Depends on arts
    this.generatedBuildList = new GeneratedBuildListDataManager(this)
    // Depends on arts and generatedBuildList
    this.optConfigs = new OptConfigDataManager(this)

    this.buildTcs = new BuildTcDataManager(this)
    this.charMeta = new CharMetaDataManager(this)

    this.builds = new BuildDataManager(this)

    // Depends on builds, buildTcs, and optConfigs
    this.teamChars = new TeamCharacterDataManager(this)

    // Depends on TeamChar
    this.teams = new TeamDataManager(this)

    // Handle DataEntries
    this.dbMeta = new DBMetaEntry(this)
    this.displayWeapon = new DisplayWeaponEntry(this)
    this.displayArtifact = new DisplayArtifactEntry(this)
    this.displayCharacter = new DisplayCharacterEntry(this)
    this.displayTool = new DisplayToolEntry(this)
    this.displayTeam = new DisplayTeamEntry(this)
    this.displayArchive = new DisplayArchiveEntry(this)

    // invalidates character when things change.
    // Skipped during a rebuild: those changes were authored by another tab, which
    // already stamped `lastEdit` itself. Without this, replaying a rebuild would
    // queue one `dbMeta` write per restored record.
    const updateLastEdit = () => {
      if (this.isRebuilding) return
      this.dbMeta.set({ lastEdit: Date.now() })
    }

    // IMPORTANT: do not follow changes made to dbMeta,
    // as it would end in infinite loop
    this.chars.followAny(updateLastEdit)
    this.arts.followAny(updateLastEdit)
    this.weapons.followAny(updateLastEdit)
    this.optConfigs.followAny(updateLastEdit)
    this.buildTcs.followAny(updateLastEdit)
    this.charMeta.followAny(updateLastEdit)
    this.builds.followAny(updateLastEdit)
    this.teamChars.followAny(updateLastEdit)
    this.teams.followAny(updateLastEdit)
    this.displayWeapon.follow(updateLastEdit)
    this.displayArtifact.follow(updateLastEdit)
    this.displayCharacter.follow(updateLastEdit)
    this.displayTool.follow(updateLastEdit)
    this.displayTeam.follow(updateLastEdit)
    this.displayArchive.follow(updateLastEdit)
  }
  get dataManagers() {
    // IMPORTANT: it must be chars, weapon, arts in order, to respect import order
    return [
      this.chars,
      this.weapons,
      this.arts,
      this.generatedBuildList,
      this.optConfigs,
      this.buildTcs,
      this.charMeta,
      this.builds,
      this.teamChars,
      this.teams,
    ] as const
  }
  get dataEntries() {
    return [
      this.dbMeta,
      this.displayWeapon,
      this.displayArtifact,
      this.displayCharacter,
      this.displayTool,
      this.displayTeam,
      this.displayArchive,
    ] as const
  }

  clear() {
    this.dataManagers.map((dm) => dm.clear())
    this.dataEntries.map((de) => de.clear())
  }
  get gender() {
    const gender: GenderKey = this.dbMeta.get().gender ?? 'F'
    return gender
  }
  exportGOOD() {
    const good: Partial<IGO & IGOOD> = {
      format: 'GOOD',
      dbVersion: currentDBVersion,
      source: GOSource,
      version: 3,
    }
    this.dataManagers.map((dm) => dm.exportGOOD(good))
    this.dataEntries.map((de) => de.exportGOOD(good))
    return good as IGO & IGOOD
  }
  importGOOD(
    good: IGOOD & IGO,
    keepWepArtiNotInImport: boolean,
    keepCharNotInImport: boolean,
    ignoreDups: boolean
  ): ImportResult {
    good = migrateGOOD(good)
    const source = good.source ?? 'Unknown'
    // Some Scanners might carry their own id field, which would conflict with GO dup resolution.
    if (source !== 'Genshin Optimizer') {
      good.artifacts?.forEach(
        (a) => delete (a as unknown as { id?: string }).id
      )
      good.weapons?.forEach((a) => delete (a as unknown as { id?: string }).id)
    }
    const result: ImportResult = newImportResult(
      source,
      keepWepArtiNotInImport,
      keepCharNotInImport,
      ignoreDups
    )

    // Follow updates from char/art/weapon to gather import results
    const unfollows = [
      this.chars.followAny((key, reason, value) => {
        const arr = result.characters[reason]
        const ind = arr.findIndex((c) => c?.key === key)
        if (ind < 0) arr.push(value)
        else arr[ind] = value
      }),
      this.arts.followAny((_key, reason, value) =>
        result.artifacts[reason].push(value)
      ),
      this.weapons.followAny((_key, reason, value) =>
        result.weapons[reason].push(value)
      ),
    ]

    this.dataManagers.map((dm) => dm.importGOOD(good, result))
    this.dataEntries.map((de) => de.importGOOD(good, result))
    this.weapons.ensureEquipments()
    unfollows.forEach((f) => f())

    return result
  }
  clearStorage() {
    this.dataManagers.map((dm) => dm.clearStorage())
    this.dataEntries.map((de) => de.clearStorage())
  }
  saveStorage() {
    this.dataManagers.map((dm) => dm.saveStorage())
    this.dataEntries.map((de) => de.saveStorage())
    this.storage.setDBVersion(this.dbVer)
    this.storage.setDBIndex(this.dbIndex)
  }
  swapStorage(other: ArtCharDatabase) {
    this.clearStorage()
    other.clearStorage()

    const thisStorage = this.storage
    this.storage = other.storage
    other.storage = thisStorage

    this.saveStorage()
    other.saveStorage()
  }
  /**
   * The whole database as the plain object an inactive slot is stored as.
   */
  private extraEntries(): Record<string, unknown> {
    const other = new SandboxStorage()
    const oldstorage = this.storage
    this.storage = other
    this.saveStorage()
    this.storage = oldstorage
    return Object.fromEntries(other.entries)
  }

  /**
   * Deterministic plain-JSON form of the whole database.
   *
   * Only used to decide whether an inactive slot actually needs rewriting.
   * `compressToB64Gzip` stamps the current mtime into the gzip header, so its
   * output differs between calls on identical input and cannot be compared.
   */
  serializeExtra(): string {
    return JSON.stringify(this.extraEntries())
  }

  override toExtraLocalDB() {
    const key = `extraDatabase_${this.storage.getDBIndex()}`
    localStorage.setItem(key, compressToB64Gzip(this.extraEntries()))
  }

  /** Storage keys owned by this database, for cross-tab sync. */
  static readonly syncKeys = {
    prefixes: [
      'artifact_',
      'char_',
      'weapon_',
      'build_',
      'buildTc_',
      'optConfig_',
      'charMeta_',
      'generatedBuildList_',
      'team_',
      'teamchar_',
    ],
    exact: ['db_ver'],
  } as const
  get syncKeys() {
    return ArtCharDatabase.syncKeys
  }

  /**
   * Re-read the whole database from storage, after another tab changed it.
   *
   * This deliberately rebuilds everything rather than patching the changed key.
   * `ArtifactDataManager.toCache` is not a pure decoder - it re-derives character
   * equipment relations from the *local* previous value - so applying one remote
   * record in isolation can leave this tab's cache disagreeing with storage.
   * Replaying the constructor's order reproduces boot semantics exactly, which is
   * the only state we know to be self-consistent.
   *
   * Mutates in place: `generateBuilds` holds this instance across a long run, and
   * every `useSyncExternalStore` subscription is bound to these manager objects.
   */
  reloadFromStorage() {
    this.withRebuild(() => {
      this.dbVer = this.storage.getDBVersion()
      // Clear every cache BEFORE scanning any of them. `CharacterDataManager`
      // rebuilds `equippedArtifacts`/`equippedWeapon` by searching the artifact
      // and weapon caches, so scanning characters while those still hold the
      // previous state would resurrect equipment the other tab just moved.
      // Emptying everything first reproduces the constructor's starting point.
      this.dataManagers.forEach((dm) => dm.resetCache())
      // IMPORTANT: same order as the constructor. Cannot reuse `dataManagers`,
      // which omits `ensureEquipments` and orders generatedBuildList/optConfigs
      // only incidentally.
      this.chars.scanStorage()
      this.weapons.scanStorage()
      this.arts.scanStorage()
      this.weapons.ensureEquipments()
      this.generatedBuildList.scanStorage()
      this.optConfigs.scanStorage()
      this.buildTcs.scanStorage()
      this.charMeta.scanStorage()
      this.builds.scanStorage()
      this.teamChars.scanStorage()
      this.teams.scanStorage()
      this.dataEntries.forEach((de) => de.reload())
    })
  }
}
