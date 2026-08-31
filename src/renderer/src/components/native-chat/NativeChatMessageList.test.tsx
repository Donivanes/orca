// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

afterEach(cleanup)

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Selectable agent response.' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'ready',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

describe('NativeChatMessageList assistant messages', () => {
  it('keeps prose selectable and places non-selectable controls after it', () => {
    render(
      <NativeChatMessageList
        session={session}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    const prose = screen.getByText('Selectable agent response.')
    const row = prose.closest('.group')
    const copyButton = screen.getByRole('button', { name: 'Copy message' })
    const controls = copyButton.parentElement

    expect(row).toHaveClass('select-text')
    expect(controls).toHaveClass('select-none', 'pointer-events-none', 'mt-1')
    expect(controls).not.toHaveClass('absolute')
    expect(prose.compareDocumentPosition(controls!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('keeps a running tool live when transcript lifecycle metadata is absent', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'assistant-tool-1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Running sleep 5')).toBeInTheDocument()
    expect(screen.queryByText('1×')).toBeNull()
    expect(document.querySelector('.text-destructive')).toBeNull()
  })

  it('shows a stable thinking status above the transcript', () => {
    const { container } = render(
      <NativeChatMessageList
        session={{ ...session, status: 'working', messages: [] }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Thinking')).toBeInTheDocument()
    expect(screen.getByText('Thinking')).toHaveClass('border-b')
    expect(container.querySelector('.animate-bounce')).toBeNull()
  })

  it('shows elapsed working time once tool activity starts', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'tool-1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        workingStartedAt={Date.now() - 3000}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Working for 3 seconds')).toBeInTheDocument()
  })
})
