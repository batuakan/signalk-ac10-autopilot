import { EventEmitter } from 'node:events'
import { AC10Pilot, DEFAULT_CONFIG, PilotConfig, Remote } from '../src/ac10'

export const deg = (d: number) => (d * Math.PI) / 180
export const toDeg = (r: number) => Math.round((r * 180) / Math.PI * 1000) / 1000

/** Behaves like the ESPHome firmware: STBY-AUTO toggles the Lamp */
export class FakeRemote extends EventEmitter implements Remote {
  connected = true
  engaged: boolean | undefined = false
  pendingSteps = 0
  presses: string[] = []
  sentSteps: number[] = []
  /** Set false to simulate an AC10 that ignores the mode key */
  respond = true

  description = 'fake'
  start() {}
  stop() {}

  async engage() {
    this.presses.push('engage')
    if (this.respond && !this.engaged) setTimeout(() => this.setEngaged(true), 10)
  }

  async standby() {
    this.presses.push('standby')
    if (this.respond && this.engaged) setTimeout(() => this.setEngaged(false), 10)
  }

  async steps(count: number) {
    this.sentSteps.push(count)
  }

  setEngaged(v: boolean | undefined) {
    this.engaged = v
    this.emit('engaged', v)
  }
}

export class FakeApp {
  paths: Record<string, unknown> = {}
  deltas: { path: string; value: unknown }[] = []
  errors: string[] = []
  busCallbacks: Record<string, ((v: { value: unknown; $source?: string }) => void)[]> = {}
  activated: unknown[] = []
  course: unknown = { activeRoute: null }

  debug() {}
  error(msg: string) {
    this.errors.push(msg)
  }
  getSelfPath(path: string) {
    return this.paths[path]
  }
  handleMessage(_id: string, delta: { updates: { values: { path: string; value: unknown }[] }[] }) {
    delta.updates.forEach((u) =>
      u.values.forEach((v) => {
        this.deltas.push(v)
        this.paths[v.path + '.value'] = v.value
      })
    )
  }
  streambundle = {
    getSelfBus: (path: string) => ({
      onValue: (fn: (v: { value: unknown; $source?: string }) => void) => {
        ;(this.busCallbacks[path] ??= []).push(fn)
        return () => {}
      }
    })
  }
  emitBus(path: string, value: unknown, $source = 'ttyUSB0.AG') {
    this.busCallbacks[path]?.forEach((fn) => fn({ value, $source }))
  }
  async getCourse() {
    return this.course as never
  }
  async activateRoute(dest: unknown) {
    this.activated.push(dest)
  }
  last(path: string) {
    return [...this.deltas].reverse().find((d) => d.path === path)?.value
  }
}

export function makePilot(over: Partial<PilotConfig> = {}, routeOver: Partial<PilotConfig['route']> = {}) {
  const app = new FakeApp()
  const remote = new FakeRemote()
  const cfg: PilotConfig = {
    ...DEFAULT_CONFIG,
    confirmTimeout: 0.3,
    ...over,
    route: { ...DEFAULT_CONFIG.route, interval: 3600, ...routeOver }
  }
  const pilot = new AC10Pilot(app, remote, cfg, 'ac10-autopilot')
  pilot.start()
  return { app, remote, pilot }
}
