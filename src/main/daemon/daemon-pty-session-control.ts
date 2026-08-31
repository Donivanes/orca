import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { GET_SIZE_PROTOCOL_VERSION } from './daemon-protocol-version'
import { DaemonPtySessionShutdown } from './daemon-pty-session-shutdown'
import { providerSequenceFromCreateOrAttach } from './daemon-pty-provider-sequence'
import { SessionNotFoundError, type CreateOrAttachResult, type ListSessionsResult } from './types'
import type { PtySpawnResult } from '../providers/types'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

export abstract class DaemonPtySessionControl extends DaemonPtySessionShutdown {
  async attach(id: string): Promise<Pick<PtySpawnResult, 'providerSequence'> | void> {
    await this.ensureConnected()
    if (!this.canDelegateBackgroundToDaemon) {
      this.setPtyBackgrounded(id, false)
    }

    // Why size-first: attach must ride the session's own geometry — a fixed
    // 80×24 here could resize a live agent's TUI — and a null size means the
    // daemon cannot prove the session, so refuse rather than risk a create.
    const size = await this.getAppliedSize(id)
    if (!size) {
      throw new SessionNotFoundError(id)
    }
    const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: id,
      cols: size.cols,
      rows: size.rows,
      attachOnly: true
    })
    if (result.isNew) {
      // Why: a pre-v31 daemon ignores attachOnly; retire its accidental spawn
      // instead of publishing a fresh shell as an attach.
      await this.client.request('kill', { sessionId: id, immediate: true }).catch((error) => {
        // Why surface, not swallow: a failed retire leaves an untracked orphan shell.
        console.warn('[daemon] attach-only retire of accidental legacy spawn failed', {
          sessionId: id,
          error
        })
      })
      throw new SessionNotFoundError(id)
    }
    this.clearSessionAwaitingDaemonRecovery(id)
    const providerSequence = providerSequenceFromCreateOrAttach(result)
    return providerSequence ? { providerSequence } : undefined
  }

  hasPty(id: string): boolean {
    return this.activeSessionIds.has(id)
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    try {
      if (!this.getSizeUnsupported && this.protocolVersion >= GET_SIZE_PROTOCOL_VERSION) {
        try {
          const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
            'getSize',
            { sessionId: id },
            LIVENESS_PROBE_TIMEOUT_MS
          )
          return result.size !== null
        } catch (error) {
          // Why the capability probe rather than the version alone: `getSize` shipped into an
          // already-released protocol without a bump, so a daemon can report a version that
          // implies support and still reject the request. Ask what it can do, not what its
          // number implies — and remember the answer so later probes skip the dead round trip.
          if (!isUnknownRequestTypeError(error)) {
            throw error
          }
          this.getSizeUnsupported = true
        }
      }
      // Why: a daemon without `getSize` would otherwise answer `null` forever, and one `null`
      // makes the whole owner fan-out unprovable — a dead pane could then never be retired.
      // `listSessions` is the same inventory legacy discovery routes by, and has existed since
      // the first daemon protocol. Requested directly rather than through `listProcesses` so a
      // liveness probe does not publish inventory audit observations as a side effect; both
      // rethrow on failure, so either way a dead socket stays `null` instead of reading absent.
      const { sessions } = await this.client.request<ListSessionsResult>(
        'listSessions',
        undefined,
        LIVENESS_PROBE_TIMEOUT_MS
      )
      return sessions.some((session) => session.sessionId === id && session.isAlive)
    } catch {
      return null
    }
  }

  write(id: string, data: string): boolean {
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(id, this.client.notify('write', { sessionId: id, data }), recoverable)
  }

  async writeWithSettlement(id: string, data: string): Promise<boolean> {
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(
      id,
      await this.client.notifyWithSettlement('write', { sessionId: id, data }),
      recoverable
    )
  }

  protected prepareWrite(id: string): boolean {
    this.markSessionDirty(id)
    // Why recoverable and not just active: rejecting a write asks the pane to remount,
    // which only helps if this endpoint can come back. A legacy adapter has no respawn,
    // so its reattach fails and the pane rebuilds empty — losing scrollback the user
    // could still read. Keep the pre-existing silent drop for those.
    const recoverable =
      this.activeSessionIds.has(id) && !this.respawnAdoptionClosed && Boolean(this.respawnFn)
    if (
      recoverable &&
      (this.sessionsAwaitingDaemonRecovery.has(id) || !this.client.isConnected())
    ) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.reconnectAfterWriteFailure()
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return recoverable
  }

  protected finishWrite(id: string, delivered: boolean, recoverable: boolean): boolean {
    if (!delivered && recoverable) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.reconnectAfterWriteFailure()
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return delivered
  }

  resize(id: string, cols: number, rows: number): void {
    this.markSessionDirty(id)
    this.client.notify('resize', { sessionId: id, cols, rows })
  }

  pauseProducer(id: string): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.add(id)
    this.client.notify('pausePty', { sessionId: id })
  }

  resumeProducer(id: string): void {
    this.producerResumesOwedOnReconnect.delete(id)
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.delete(id)
    this.client.notify('resumePty', { sessionId: id })
  }

  // Why fire-and-forget (like pausePty): just a delivery hint for the daemon's keep-tail stream thinning.
  setPtyBackgrounded(id: string, background: boolean): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    // Why: preserved daemons without a sequence-safe, faithful serializer cannot heal a thinned stream.
    // Why also gate on 2031 (#9993): backgrounding is what hands transient-fact scan
    // authority to the daemon. A pre-v29 daemon can announce a 2031 subscribe but never
    // retract it, so a TUI exiting while hidden would strand the subscription and the
    // next theme flip would inject CSI 997 into its replacement shell. Declining to
    // background keeps main's scanner — which emits both facts — authoritative.
    const safeBackground = this.canDelegateBackgroundToDaemon && background
    if (safeBackground) {
      this.backgroundedSessionIds.add(id)
    } else {
      this.backgroundedSessionIds.delete(id)
    }
    this.client.notify('setSessionBackground', { sessionId: id, background: safeBackground })
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.client.request('signal', { sessionId: id, signal })
  }

  async getCwd(id: string): Promise<string> {
    try {
      const result = await this.client.request<{ cwd: string | null }>('getCwd', {
        sessionId: id
      })
      return result.cwd ?? ''
    } catch {
      return ''
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.initialCwds.get(id) ?? ''
  }

  // Why: resize() is fire-and-forget and can be dropped daemon-side; read the actually-applied size so the renderer can detect drift and re-assert.
  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
        'getSize',
        { sessionId: id }
      )
      return result.size ?? null
    } catch {
      return null
    }
  }
}
