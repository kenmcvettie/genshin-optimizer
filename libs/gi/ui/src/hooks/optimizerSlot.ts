/** Web Lock held for the duration of an optimization, by every tab running one. */
const OPTIMIZER_LOCK = 'go-optimizing'

export interface OptimizerSlot {
  /** Worker count to actually use, after splitting the CPU between tabs. */
  effectiveWorkers: number
  /** Must be called when the solve finishes, in a `finally`. */
  release: () => void
}

/**
 * Claim a share of the CPU for one optimization run.
 *
 * Now that several tabs can optimize at once, each spawning `hardwareConcurrency`
 * workers would oversubscribe the machine and make every run slower. Each tab
 * holds a *shared* lock while solving, so counting the holders gives the number
 * of concurrent optimizations to divide by.
 *
 * The user's configured worker count is never modified - only the per-run figure
 * derived from it - because `useNumWorkers` persists its value to localStorage
 * and writing a divided number back would permanently degrade the setting.
 */
export async function acquireOptimizerSlot(
  maxWorkers: number
): Promise<OptimizerSlot> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks?.request)
    return { effectiveWorkers: maxWorkers, release: () => {} }

  let concurrent = 1
  try {
    // Query before acquiring, so we don't count ourselves twice.
    const { held } = await locks.query()
    concurrent =
      (held?.filter((lock) => lock.name === OPTIMIZER_LOCK).length ?? 0) + 1
  } catch {
    // `query` is permission-gated in some browsers; assume we're alone.
  }

  let release = () => {}
  const acquired = new Promise<void>((resolve) => {
    locks
      .request(
        OPTIMIZER_LOCK,
        { mode: 'shared' },
        () =>
          new Promise<void>((releaseLock) => {
            release = releaseLock
            resolve()
          })
      )
      // A failed acquisition must not stall the solve.
      .catch(() => resolve())
  })
  await acquired

  return {
    effectiveWorkers: Math.max(1, Math.floor(maxWorkers / concurrent)),
    release: () => release(),
  }
}
