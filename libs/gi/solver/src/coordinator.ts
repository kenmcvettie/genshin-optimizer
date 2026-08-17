import { FIFO } from '@genshin-optimizer/common/util'

export class WorkerCoordinator<
  Command extends { command: string; resultType?: never },
  Response extends { command?: never; resultType: string },
> {
  prio: Map<Command['command'], number>
  commands: FIFO<Command>[]
  workers: Promise<Worker>[]
  workDone: Map<Worker, () => void> = new Map()
  _workers: Worker[]

  cancel: (e?: Error) => void
  cancelled: Promise<never>
  callback: (_: Response, w: Worker) => void
  notifyNonEmpty: (() => void) | undefined

  constructor(
    workers: Worker[],
    prio: Command['command'][],
    callback: (_: Response, w: Worker) => void
  ) {
    this.commands = prio.map((_) => new FIFO())
    this.prio = new Map(prio.map((p, i) => [p, i]))
    this.callback = callback

    workers.forEach((worker) => {
      worker.onmessage = (x) => this.onMessage(x.data, worker)
      worker.onerror = (e) => this.onError(e)
    })
    this._workers = workers
    this.workers = workers.map((w) => Promise.resolve(w))
    this.cancel = () => {}
    this.cancelled = new Promise<never>((_, rej) => (this.cancel = rej))
    // `this._workers`, not the constructor argument: workers added later by
    // `addWorkers` must be terminated on cancel too, or they outlive the solve.
    this.cancelled.catch((_) => this._workers.forEach((w) => w.terminate()))
  }

  get workerCount() {
    return this._workers.length
  }

  /**
   * Add workers to a pool that is already running.
   *
   * Used to reclaim CPU when a concurrent optimization in another tab finishes.
   * `setup` is replayed to each new worker so it starts from the same state the
   * original pool was primed with.
   *
   * Growth is not instantaneous: if `execute` is already parked waiting on the
   * current workers, it only re-races the pool after one of them reports back,
   * so a new worker picks up work at the next chunk boundary.
   */
  addWorkers(count: number, makeWorker: () => Worker, setup?: Command) {
    for (let i = 0; i < count; i++) {
      const worker = makeWorker()
      worker.onmessage = (x) => this.onMessage(x.data, worker)
      worker.onerror = (e) => this.onError(e)
      this._workers.push(worker)
      if (setup) {
        this.workers.push(
          new Promise((res) => this.workDone.set(worker, () => res(worker)))
        )
        worker.postMessage(setup)
      } else this.workers.push(Promise.resolve(worker))
    }
    if (count > 0) this.notifyNonEmpty?.()
  }

  /**
   * Send `commands` to available workers. If a worker sends back a `Command`,
   * that command is further sent to an available worker (may be the same worker).
   * If a worker sends back a `Response`, `this.callback` is invoked.
   *
   * Note that `{ resultType: 'done' }` is a special type that the worker is
   * expected to send back when completing its `command`.
   */
  async execute(commands: Iterable<Command> | AsyncIterable<Command>) {
    const processingInput = (async () => {
      for await (const command of commands) this.add(command)
    })()

    while (true) {
      const command = this.commands.find((x) => x.length)?.pop()
      if (command === undefined) {
        const hasCommand = await Promise.race([
          new Promise<boolean>(
            (res) => (this.notifyNonEmpty = () => res(true))
          ),
          Promise.all([...this.workers, processingInput]).then((_) => false),
          this.cancelled,
        ])

        this.notifyNonEmpty = undefined
        if (hasCommand) continue
        break
      }

      const { i, w } = await Promise.race([
        ...this.workers.map((w, i) => w.then((w) => ({ i, w }))),
        this.cancelled,
      ])
      this.workers[i] = new Promise((res) => this.workDone.set(w, () => res(w)))
      w.postMessage(command)
    }
  }

  onError(e: { message: string }) {
    this.cancel(new Error(`Worker Error: ${e.message}`))
  }
  onMessage(msg: Command | Response, worker: Worker) {
    if (msg.command !== undefined) this.add(msg as Command)
    else if (msg.resultType === 'done') this.workDone.get(worker)!()
    else this.callback(msg as Response, worker)
  }
  /** May be ignored after `execute` ends */
  add(command: Command) {
    const prio = this.prio.get(command.command)!
    this.commands[prio].push(command)
    this.notifyNonEmpty?.()
  }
  /** May be ignored after `execute` ends */
  broadcast(command: Command) {
    this._workers.forEach((w) => w.postMessage(command))
  }
  /** MUST be followed by `execute` and cannot be called while `execute` is running */
  notifiedBroadcast(command: Command) {
    this.workers = this.workers.map((worker) =>
      worker.then(
        (w) =>
          new Promise((res) => {
            this.workDone.set(w, () => res(w))
          })
      )
    )
    this._workers.forEach((w) => w.postMessage(command))
  }
}
