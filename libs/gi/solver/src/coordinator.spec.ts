import { WorkerCoordinator } from './coordinator'

type Cmd = { command: 'work'; id: number; resultType?: never }
type Res = { command?: never; resultType: 'done' | 'ack'; id?: number }

/** Minimal stand-in for a Web Worker: records messages, replies on demand. */
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  received: unknown[] = []
  terminated = false
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(msg: unknown) {
    this.received.push(msg)
  }
  terminate() {
    this.terminated = true
  }
  /** Simulate the worker finishing whatever it was told to do. */
  reply(msg: Res = { resultType: 'done' }) {
    this.onmessage?.({ data: msg })
  }
}

const make = () => new FakeWorker() as unknown as Worker

describe('WorkerCoordinator.addWorkers', () => {
  beforeEach(() => {
    FakeWorker.all = []
  })

  it('grows the pool and primes new workers with the setup command', () => {
    const initial = [make(), make()]
    const c = new WorkerCoordinator<Cmd, Res>(initial, ['work'], () => {})
    expect(c.workerCount).toBe(2)

    const setup: Cmd = { command: 'work', id: 99 }
    c.addWorkers(2, make, setup)

    expect(c.workerCount).toBe(4)
    const added = FakeWorker.all.slice(2)
    expect(added).toHaveLength(2)
    // Without replaying setup, a new worker would start from the wrong state.
    for (const w of added) expect(w.received).toEqual([setup])
  })

  it('leaves new workers unavailable until they acknowledge setup', async () => {
    const c = new WorkerCoordinator<Cmd, Res>([make()], ['work'], () => {})
    c.addWorkers(1, make, { command: 'work', id: 1 })

    const added = FakeWorker.all[1]
    let settled = false
    // `workers` holds one promise per worker, pending while that worker is busy.
    c.workers[1].then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    added.reply({ resultType: 'done' })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('terminates workers added after construction when cancelled', () => {
    const c = new WorkerCoordinator<Cmd, Res>([make()], ['work'], () => {})
    c.addWorkers(2, make)
    c.cancel(new Error('stop'))
    // `cancelled` rejects; swallow it so the test does not see an unhandled reject.
    c.cancelled.catch(() => {})

    return Promise.resolve().then(() => {
      // Regression: the terminate handler used to close over the constructor's
      // array, so workers added later outlived a cancelled solve.
      expect(FakeWorker.all).toHaveLength(3)
      for (const w of FakeWorker.all) expect(w.terminated).toBe(true)
    })
  })

  it('is a no-op for a non-positive count', () => {
    const c = new WorkerCoordinator<Cmd, Res>([make()], ['work'], () => {})
    c.addWorkers(0, make)
    c.addWorkers(-3, make)
    expect(c.workerCount).toBe(1)
  })
})
