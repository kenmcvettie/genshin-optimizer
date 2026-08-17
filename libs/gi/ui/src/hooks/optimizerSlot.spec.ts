import { effectiveWorkersFor } from './optimizerSlot'

describe('effectiveWorkersFor', () => {
  it('gives a lone run the full configured count', () => {
    expect(effectiveWorkersFor(16, 1)).toBe(16)
    expect(effectiveWorkersFor(4, 1)).toBe(4)
  })

  it('splits the CPU between concurrent runs', () => {
    expect(effectiveWorkersFor(16, 2)).toBe(8)
    expect(effectiveWorkersFor(16, 3)).toBe(5)
    expect(effectiveWorkersFor(16, 4)).toBe(4)
  })

  it('never drops below one worker', () => {
    // More tabs than cores must not stall a run outright.
    expect(effectiveWorkersFor(2, 8)).toBe(1)
    expect(effectiveWorkersFor(1, 100)).toBe(1)
  })

  it('treats a missing or nonsensical concurrency as being alone', () => {
    // `countRunningOptimizations` returns 0 when the Web Locks API is missing.
    expect(effectiveWorkersFor(16, 0)).toBe(16)
    expect(effectiveWorkersFor(16, -1)).toBe(16)
  })
})
