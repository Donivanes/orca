import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: `providesInitialSurface: true` is invisible to behavior tests — every opted-out caller
// still works with the flag deleted, it just re-seeds a shell the user never asked for in a
// closed-last-terminal workspace. Three review rounds each found a missed caller, so this is
// the census: activation callers that open their own surface (editor, browser, diff, agent tab)
// must appear here, and adding or removing an opt-out anywhere must update this list.
const SURFACE_PROVIDING_CALLER_CONTRACTS = {
  'src/renderer/src/components/editor/check-annotation-open.ts': { calls: 1, optedOut: 1 },
  'src/renderer/src/components/feature-wall/FeatureWallBrowserAction.tsx': {
    calls: 1,
    optedOut: 1
  },
  'src/renderer/src/components/sidebar/NonGitFolderDialog.tsx': { calls: 2, optedOut: 1 },
  'src/renderer/src/components/sidebar/folder-workspace-composer-submit.ts': {
    calls: 2,
    optedOut: 1
  },
  'src/renderer/src/components/sidebar/run-worktree-delete-with-toast.ts': {
    calls: 1,
    optedOut: 1
  },
  'src/renderer/src/components/terminal-pane/terminal-file-open-routing.ts': {
    calls: 4,
    optedOut: 3
  },
  'src/renderer/src/hooks/composer-state/full-creation-execution.ts': { calls: 1, optedOut: 1 },
  'src/renderer/src/lib/fix-checks-agent-launch.ts': { calls: 1, optedOut: 1 },
  'src/renderer/src/lib/launch-work-item-direct.ts': { calls: 2, optedOut: 1 },
  'src/renderer/src/lib/workspace-port-actions.ts': { calls: 2, optedOut: 1 },
  'src/renderer/src/lib/worktree-creation-flow-execute.ts': { calls: 1, optedOut: 1 },
  'src/renderer/src/store/repos/repo-add-actions.ts': { calls: 2, optedOut: 1 }
} as const

const SURFACE_PROVIDING_CALLERS = Object.keys(SURFACE_PROVIDING_CALLER_CONTRACTS)

// The activation seam itself: declares the option and forwards it into the tombstone gate.
const SEAM_FILES = ['src/renderer/src/lib/worktree-activation.ts']

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath)
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      return []
    }
    return [fullPath]
  })
}

// Why: bound to an actual activation call so a comment or dead code containing the flag
// text cannot satisfy the census, and a variable-valued flag cannot hide in it. Comments
// are stripped first — commenting the flag out in place must fail this test.
const ACTIVATION_CALL = /activateAndReveal(?:Worktree|FolderWorkspace|Workspace)\s*\(/g

function listActivationCallArgs(source: string): string[] {
  const calls: string[] = []
  for (const match of source.matchAll(ACTIVATION_CALL)) {
    const start = (match.index ?? 0) + match[0].length
    let depth = 1
    let quote: "'" | '"' | '`' | null = null
    let escaped = false
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]
      if (quote) {
        if (escaped) {
          escaped = false
        } else if (character === '\\') {
          escaped = true
        } else if (character === quote) {
          quote = null
        }
        continue
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character
      } else if (character === '(') {
        depth += 1
      } else if (character === ')') {
        depth -= 1
        if (depth === 0) {
          calls.push(source.slice(start, index))
          break
        }
      }
    }
  }
  return calls
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('providesInitialSurface caller wiring', () => {
  it.each(SURFACE_PROVIDING_CALLERS)(
    '%s preserves every activation call contract',
    (relativePath) => {
      const source = stripComments(readFileSync(join(process.cwd(), relativePath), 'utf8'))
      const calls = listActivationCallArgs(source)
      const contract =
        SURFACE_PROVIDING_CALLER_CONTRACTS[
          relativePath as keyof typeof SURFACE_PROVIDING_CALLER_CONTRACTS
        ]
      expect(calls).toHaveLength(contract.calls)
      expect(calls.filter((args) => args.includes('providesInitialSurface: true'))).toHaveLength(
        contract.optedOut
      )
    }
  )

  it('the census matches every mention under src/', () => {
    const root = join(process.cwd(), 'src')
    const mentions = listSourceFiles(root)
      .filter((filePath) => readFileSync(filePath, 'utf8').includes('providesInitialSurface'))
      .map((filePath) => relative(process.cwd(), filePath).split(sep).join('/'))
      .sort()
    expect(mentions).toEqual([...SURFACE_PROVIDING_CALLERS, ...SEAM_FILES].sort())
  })
})
