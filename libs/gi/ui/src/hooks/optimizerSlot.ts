import { useEffect, useState } from 'react'

/** Web Lock held for the duration of an optimization, by every tab running one. */
const OPTIMIZER_LOCK = 'go-optimizing'

function locksApi() {
  return typeof navigator === 'undefined' ? undefined : navigator.locks
}

/**
 * How many optimizations are running right now, across every tab.
 *
 * Returns 0 when the Web Locks API is unavailable, so callers can treat a
 * non-positive result as "assume we're alone".
 */
export async function countRunningOptimizations(): Promise<number> {
  const locks = locksApi()
  if (!locks?.query) return 0
  try {
    const { held } = await locks.query()
    return (held ?? []).filter((lock) => lock.name === OPTIMIZER_LOCK).length
  } catch {
    // `query` is permission-gated in some browsers.
    return 0
  }
}

/**
 * The user's configured worker count, divided by the number of tabs competing
 * for the CPU.
 *
 * The configured value is never modified - only this derived per-run figure -
 * because `useNumWorkers` persists its value, and writing a divided number back
 * would permanently degrade the setting.
 */
export function effectiveWorkersFor(maxWorkers: number, concurrent: number) {
  return Math.max(1, Math.floor(maxWorkers / Math.max(1, concurrent)))
}

/**
 * Live count of concurrent optimizations, for display.
 *
 * Web Locks has no change event, so this polls. It only runs while the document
 * is visible - a backgrounded tab has nothing to show.
 */
export function useOptimizerConcurrency(pollMs = 2000): number {
  const [concurrent, setConcurrent] = useState(0)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (cancelled) return
      if (!document.hidden) {
        const n = await countRunningOptimizations()
        if (!cancelled) setConcurrent(n)
      }
      timer = setTimeout(poll, pollMs)
    }
    poll()
    const onVisible = () => !document.hidden && poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pollMs])
  return concurrent
}

export interface OptimizerSlot {
  /** Worker count to actually use, after splitting the CPU between tabs. */
  effectiveWorkers: number
  /** Must be called when the solve finishes, in a `finally`. */
  release: () => void
}

/**
 * Claim a share of the CPU for one optimization run.
 *
 * Several tabs can optimize at once, and each spawning `hardwareConcurrency`
 * workers would oversubscribe the machine and make every run slower. Each tab
 * holds a *shared* lock while solving, so counting the holders gives the number
 * of concurrent runs to divide by.
 */
export async function acquireOptimizerSlot(
  maxWorkers: number
): Promise<OptimizerSlot> {
  const locks = locksApi()
  if (!locks?.request)
    return { effectiveWorkers: maxWorkers, release: () => {} }

  // Query before acquiring, so we don't count ourselves twice.
  const concurrent = (await countRunningOptimizations()) + 1

  let release = () => {}
  await new Promise<void>((resolve) => {
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

  return {
    effectiveWorkers: effectiveWorkersFor(maxWorkers, concurrent),
    release: () => release(),
  }
}
