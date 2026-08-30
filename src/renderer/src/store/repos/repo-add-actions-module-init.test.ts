import { describe, expect, it, vi } from 'vitest'

const importProbe = vi.hoisted(() => ({
  structuredLaunchRouterImported: false,
  structuredSessionBoundaryImported: false
}))

vi.mock('@/lib/structured-agent-session-launch', () => {
  importProbe.structuredLaunchRouterImported = true
  return { startStructuredCodexLaunch: vi.fn() }
})

vi.mock('@/lib/launch-structured-codex-session', () => {
  importProbe.structuredSessionBoundaryImported = true
  return { StructuredAgentSessionCreateRefusalError: class extends Error {} }
})

describe('repo add actions module initialization', () => {
  it('loads the repo slice without eagerly importing the store-owning launch router', async () => {
    vi.resetModules()
    importProbe.structuredLaunchRouterImported = false
    importProbe.structuredSessionBoundaryImported = false

    const { createRepoSlice } = await import('../slices/repos')

    expect(createRepoSlice).toEqual(expect.any(Function))
    expect(importProbe.structuredLaunchRouterImported).toBe(false)
    expect(importProbe.structuredSessionBoundaryImported).toBe(false)
  })
})
