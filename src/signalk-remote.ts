/*
 * The AC10 remote-port device reached through the Signal K server, using the
 * ESPHomeSignalK component (github.com/batuakan/ESPHomeSignalK) on the ESP.
 *
 * The device publishes, and handles PUTs for (signalk-server forwards a PUT
 * to the WebSocket client that publishes the path):
 *
 *   <prefix>.engaged  bool   Lamp state, on change and every 2 s (heartbeat)
 *                            PUT true = engage, false = standby
 *   <prefix>.steps    number course steps still queued
 *                            PUT n = queue n 1° steps (+ starboard, - port)
 *
 * Every PUT gets the device's own reply, so a refusal (e.g. "not engaged")
 * comes back as an error with the device's message.
 */

import { EventEmitter } from 'node:events'
import type { Remote } from './ac10'

export interface SignalKRemoteApp {
  debug(...args: unknown[]): void
  putSelfPath(
    path: string,
    value: unknown,
    updateCb: (reply: PutReply) => void
  ): Promise<unknown>
  streambundle?: {
    getSelfBus(path: string): {
      onValue(fn: (v: { value: unknown; $source?: string }) => void): () => void
    }
  }
}

interface PutReply {
  state?: string
  statusCode?: number
  message?: string
}

export interface SignalKRemoteOptions {
  /** Path prefix the device uses, default steering.autopilot.ac10 */
  prefix?: string
  /** Seconds without a heartbeat before the device counts as offline */
  staleTimeout?: number
  /** Seconds to wait for the device's PUT reply */
  putTimeout?: number
}

export const DEFAULT_PREFIX = 'steering.autopilot.ac10'

export class SignalKRemote extends EventEmitter implements Remote {
  readonly prefix: string
  private readonly staleMs: number
  private readonly putMs: number
  private lastSeen = 0
  private timer?: NodeJS.Timeout
  private unsubscribes: (() => void)[] = []

  connected = false
  engaged: boolean | undefined = undefined
  pendingSteps = 0

  constructor(
    private readonly app: SignalKRemoteApp,
    opts: SignalKRemoteOptions = {}
  ) {
    super()
    this.prefix = opts.prefix || DEFAULT_PREFIX
    this.staleMs = (opts.staleTimeout ?? 6) * 1000
    this.putMs = (opts.putTimeout ?? 5) * 1000
  }

  get description() {
    return `Signal K paths ${this.prefix}.*`
  }

  start() {
    const bus = this.app.streambundle
    if (!bus) throw new Error('Signal K streambundle not available')
    this.unsubscribes.push(
      bus.getSelfBus(`${this.prefix}.engaged`).onValue((v) => {
        if (typeof v.value !== 'boolean') return
        this.seen()
        if (v.value !== this.engaged) {
          this.engaged = v.value
          this.emit('engaged', v.value)
        }
      }),
      bus.getSelfBus(`${this.prefix}.steps`).onValue((v) => {
        const n = Number(v.value)
        if (v.value === null || !Number.isFinite(n)) return
        if (n !== this.pendingSteps) {
          this.pendingSteps = n
          this.emit('pendingSteps', n)
        }
      })
    )
    this.timer = setInterval(() => this.checkStale(), 1000)
  }

  stop() {
    clearInterval(this.timer)
    this.unsubscribes.forEach((f) => f())
    this.unsubscribes = []
    this.goOffline('stopped')
  }

  engage() {
    return this.put('engaged', true)
  }

  standby() {
    return this.put('engaged', false)
  }

  steps(count: number) {
    return this.put('steps', Math.round(count))
  }

  private put(leaf: string, value: unknown): Promise<void> {
    const path = `${this.prefix}.${leaf}`
    if (!this.connected) {
      return Promise.reject(new Error('AC10 remote interface is not connected'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (err) reject(err)
        else resolve()
      }
      const timeout = setTimeout(
        () => finish(new Error(`No reply from the AC10 remote interface to PUT ${path}`)),
        this.putMs
      )
      const onReply = (reply: unknown) => {
        const r = (reply ?? {}) as PutReply
        if (r.state === 'PENDING') return
        const code = Number(r.statusCode)
        if (code >= 200 && code < 300) finish()
        else finish(new Error(r.message || `PUT ${path} failed (${r.statusCode})`))
      }
      try {
        this.app.putSelfPath(path, value, onReply).then(onReply, (err: Error) => finish(err))
      } catch (err) {
        finish(err as Error)
      }
    })
  }

  private seen() {
    this.lastSeen = Date.now()
    if (!this.connected) {
      this.connected = true
      this.emit('connected')
    }
  }

  private checkStale() {
    if (this.connected && Date.now() - this.lastSeen > this.staleMs) {
      this.goOffline('no heartbeat from the AC10 remote interface')
    }
  }

  private goOffline(reason: string) {
    const was = this.connected
    this.connected = false
    if (this.engaged !== undefined) {
      this.engaged = undefined
      this.emit('engaged', undefined)
    }
    if (was) this.emit('disconnected', reason)
  }
}
