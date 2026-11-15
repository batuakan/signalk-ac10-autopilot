/*
 * Simrad AC10 autopilot driven through its REMOTE (R3000X / TB7) port.
 *
 * What the AC10 remote port can do (Simrad AP25 manual 20221495, §2.6):
 *   - STBY-AUTO key toggles STANDBY <-> AUTO (or WIND, if WIND is selected in
 *     the control unit's User Setup). NAV/WINDN can only be entered from a
 *     control unit because they need a prompt to be accepted.
 *   - In AUTO / WIND, each Port / Stbd press changes the set course or set
 *     wind angle by 1°.
 *   - In STANDBY, Port / Stbd move the rudder (NFU) while held. This plugin
 *     never does that; the ESPHome firmware refuses steps unless engaged.
 *   - The "Lamp" terminal is lit while an automatic mode is active. The
 *     ESPHome device senses it and reports it as "engaged".
 *
 * Everything else comes over NMEA 0183, parsed by the Signal K server:
 *   AC10 -> SK: HDG (navigation.headingMagnetic), RSA (steering.rudderAngle),
 *               HSC (steering.autopilot.target.headingMagnetic)
 *   SK -> AC10: APB/RMB/XTE (for NAV on the control unit), MWV (wind),
 *               VHW/VTG/RMC (speed) — from signalk-to-nmea0183.
 *
 * "route" is implemented by this plugin: the AC10 is put in AUTO and the set
 * course is stepped to follow the active Signal K course leg.
 */

import { EventEmitter } from 'node:events'
import {
  angleDiff,
  clamp,
  compassAngle,
  degToRad,
  radToDeg,
  routeHeading,
  signedAngle
} from './angles'

export type PilotState = 'standby' | 'auto' | 'wind' | 'route'
export type Direction = 'port' | 'starboard'

/**
 * The AC10 remote-port device, however it is reached (Signal K PUTs through
 * ESPHomeSignalK, or the ESPHome web server). Lets tests fake it.
 */
export interface Remote {
  readonly connected: boolean
  readonly engaged: boolean | undefined
  readonly pendingSteps: number
  /** Where the device is, for status messages */
  readonly description: string
  start(): void
  stop(): void
  /** STBY-AUTO key, only if the Lamp is off. Resolves when the device accepted it. */
  engage(): Promise<void>
  /** STBY-AUTO key, only if the Lamp is on; also cancels queued steps */
  standby(): Promise<void>
  /** Queue 1° steps, + = starboard. The device refuses them unless engaged. */
  steps(count: number): Promise<void>
  /** Events: engaged (boolean | undefined), connected (), disconnected (reason: string) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...args: any[]) => void): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, fn: (...args: any[]) => void): unknown
}

/** The parts of the Signal K app the pilot needs */
export interface PilotApp {
  debug(...args: unknown[]): void
  error(...args: unknown[]): void
  getSelfPath(path: string): unknown
  handleMessage(id: string, delta: object): void
  streambundle?: {
    getSelfBus(path: string): {
      onValue(fn: (v: { value: unknown; $source?: string }) => void): () => void
    }
  }
  getCourse?(): Promise<{
    activeRoute: {
      href: string
      pointIndex: number
      pointTotal: number
      reverse: boolean
    } | null
  }>
  activateRoute?(dest: {
    href: string
    pointIndex?: number
    reverse?: boolean
  }): Promise<void>
}

export interface PilotConfig {
  /** What the AC10 enters when STBY-AUTO is pressed (its User Setup) */
  engagedMode: 'auto' | 'wind'
  /** Seconds to wait for the Lamp to confirm a state change */
  confirmTimeout: number
  /** Largest single course change accepted, degrees */
  maxAdjust: number
  /** Course change for a tack in AUTO, degrees (0 disables tack in AUTO) */
  tackAngle: number
  /** Seconds an HSC target from the AC10 is considered current */
  hscTimeout: number
  route: {
    enabled: boolean
    /** Seconds between route corrections */
    interval: number
    /** Metres; XTE equal to this gives a 45° correction */
    xteLookahead: number
    /** Degrees */
    maxXteCorrection: number
    /** Max 1° steps sent per correction */
    maxStepsPerCycle: number
    /** Degrees of error ignored */
    deadband: number
    /** Seconds of missing course data before route is dropped to AUTO */
    dataTimeout: number
  }
}

export const DEFAULT_CONFIG: PilotConfig = {
  engagedMode: 'auto',
  confirmTimeout: 5,
  maxAdjust: 90,
  tackAngle: 100,
  hscTimeout: 5,
  route: {
    enabled: true,
    interval: 2,
    xteLookahead: 100,
    maxXteCorrection: 45,
    maxStepsPerCycle: 3,
    deadband: 1,
    dataTimeout: 10
  }
}

export interface PilotStatus {
  state: PilotState | null
  engaged: boolean
  target: number | null
}

const P = {
  state: 'steering.autopilot.state',
  engaged: 'steering.autopilot.engaged',
  targetHeading: 'steering.autopilot.target.headingMagnetic',
  targetWind: 'steering.autopilot.target.windAngleApparent',
  heading: 'navigation.headingMagnetic.value',
  awa: 'environment.wind.angleApparent.value',
  variation: 'navigation.magneticVariation.value',
  trackTrue: 'navigation.course.calcValues.bearingTrackTrue.value',
  trackMagnetic: 'navigation.course.calcValues.bearingTrackMagnetic.value',
  xte: 'navigation.course.calcValues.crossTrackError.value',
  notifyRemote: 'notifications.autopilot.remoteOffline',
  notifyRoute: 'notifications.autopilot.routeDataLost'
}

export class AC10Pilot extends EventEmitter<{ update: [PilotStatus] }> {
  private routeActive = false
  private target: number | null = null
  private hscTarget: number | null = null
  private hscTime = 0
  private lastCommandTime = 0
  private routeTimer?: NodeJS.Timeout
  private routeMissingSince = 0
  private routeBusy = false
  private unsubscribes: (() => void)[] = []
  private lastPublished = ''

  constructor(
    private readonly app: PilotApp,
    private readonly remote: Remote,
    private readonly cfg: PilotConfig,
    private readonly sourceId: string
  ) {
    super()
  }

  start() {
    const onEngaged = (engaged: boolean | undefined) => {
      if (engaged !== true && this.routeActive) {
        this.routeActive = false
        this.app.debug('AC10 left automatic mode, route following stopped')
      }
      if (engaged === true && this.target === null) {
        this.initTarget()
      }
      if (engaged !== true) this.target = null
      this.publish()
    }
    const onConnected = () => this.notifyRemote(true)
    const onDisconnected = (reason: string) => {
      this.app.debug('remote disconnected: ' + reason)
      this.notifyRemote(false)
    }
    this.remote.on('engaged', onEngaged)
    this.remote.on('connected', onConnected)
    this.remote.on('disconnected', onDisconnected)
    this.unsubscribes.push(
      () => this.remote.off('engaged', onEngaged),
      () => this.remote.off('connected', onConnected),
      () => this.remote.off('disconnected', onDisconnected)
    )

    // HSC from the AC10 (parsed by the server) is the authoritative set course
    const bus = this.app.streambundle?.getSelfBus(P.targetHeading)
    if (bus) {
      this.unsubscribes.push(
        bus.onValue((v) => {
          if (v.$source === this.sourceId || typeof v.value !== 'number') return
          this.onHsc(v.value)
        })
      )
    }

    if (this.cfg.route.enabled) {
      this.routeTimer = setInterval(
        () => this.routeTick(),
        this.cfg.route.interval * 1000
      )
    }
    this.notifyRemote(this.remote.connected)
    this.publish(true)
  }

  stop() {
    clearInterval(this.routeTimer)
    this.unsubscribes.forEach((f) => f())
    this.unsubscribes = []
  }

  states() {
    const states: { name: PilotState; engaged: boolean }[] = [
      { name: 'standby', engaged: false },
      { name: this.cfg.engagedMode, engaged: true }
    ]
    if (this.cfg.route.enabled) states.push({ name: 'route', engaged: true })
    return states
  }

  get status(): PilotStatus {
    const engaged = this.remote.engaged === true
    let state: PilotState | null = null
    if (this.remote.engaged === false) state = 'standby'
    else if (engaged) state = this.routeActive ? 'route' : this.cfg.engagedMode
    return { state, engaged, target: engaged ? this.target : null }
  }

  // ---- commands ------------------------------------------------------------

  async setState(state: string) {
    switch (state) {
      case 'standby':
        return this.disengage()
      case 'route':
        return this.startRoute()
      case this.cfg.engagedMode:
        await this.engage()
        if (this.routeActive) {
          this.routeActive = false
          this.publish()
        }
        return
      case 'auto':
      case 'wind':
        throw new Error(
          `The AC10 remote port engages ${this.cfg.engagedMode.toUpperCase()}; ` +
            `${state} needs the AC10 User Setup and the plugin's "engaged mode" set to ${state}`
        )
      default:
        throw new Error(`Invalid autopilot state: ${state}`)
    }
  }

  async engage() {
    this.requireRemote()
    if (this.remote.engaged === true) return
    await this.remote.engage()
    await this.waitForEngaged(true)
    this.initTarget()
    this.publish()
  }

  async disengage() {
    this.routeActive = false
    this.requireRemote()
    if (this.remote.engaged === false) {
      this.publish()
      return
    }
    await this.remote.standby()
    await this.waitForEngaged(false)
    this.publish()
  }

  /** Change course by `degrees`, positive = starboard (like the R3000X keys) */
  async adjust(degrees: number) {
    const steps = Math.round(Number(degrees))
    if (!Number.isFinite(steps)) throw new Error(`Invalid adjustment: ${degrees}`)
    if (Math.abs(steps) > this.cfg.maxAdjust) {
      throw new Error(`Adjustment ${steps}° exceeds the ${this.cfg.maxAdjust}° limit`)
    }
    this.requireEngaged()
    if (steps === 0) return
    // A manual adjustment while following a route hands control back to AUTO
    if (this.routeActive) this.routeActive = false
    await this.sendSteps(steps)
  }

  async setTargetHeading(headingRad: number) {
    if (!Number.isFinite(headingRad)) throw new Error('Invalid target heading')
    this.requireEngaged()
    if (this.status.state === 'wind') {
      throw new Error('Autopilot is in wind mode, set a wind angle instead')
    }
    const current = this.target ?? this.heading()
    if (current === undefined) throw new Error('Current set course is unknown')
    this.routeActive = false
    await this.adjust(radToDeg(angleDiff(compassAngle(headingRad), current)))
  }

  async setTargetWind(angleRad: number) {
    if (!Number.isFinite(angleRad)) throw new Error('Invalid target wind angle')
    this.requireEngaged()
    if (this.status.state !== 'wind') throw new Error('Autopilot not in wind mode')
    if (this.target === null) throw new Error('Current wind target is unknown')
    // Turning the boat to starboard reduces the apparent wind angle
    await this.adjust(-radToDeg(signedAngle(angleRad) - this.target))
  }

  async tack(direction: Direction) {
    if (direction !== 'port' && direction !== 'starboard') {
      throw new Error(`Invalid tack direction: ${direction}`)
    }
    this.requireEngaged()
    const sign = direction === 'port' ? -1 : 1
    let turn: number
    if (this.status.state === 'wind') {
      const awa = this.target ?? this.awa()
      if (awa === undefined) throw new Error('Apparent wind angle unknown')
      // Wind on starboard (awa > 0) means tacking turns to starboard
      if (Math.sign(awa) !== sign) {
        throw new Error(`Wind is on the ${awa > 0 ? 'starboard' : 'port'} side, tacking to ${direction} would gybe`)
      }
      turn = 2 * Math.abs(radToDeg(awa))
    } else {
      if (!this.cfg.tackAngle) throw new Error('Tack is disabled in AUTO')
      turn = this.cfg.tackAngle
    }
    this.routeActive = false
    this.requireEngaged()
    await this.sendSteps(sign * Math.min(Math.round(turn), 180))
  }

  /** Advance to the next point of the active Signal K route */
  async nextPoint() {
    const course = await this.app.getCourse?.()
    const route = course?.activeRoute
    if (!route || !this.app.activateRoute) throw new Error('No active route')
    if (route.pointIndex + 1 >= route.pointTotal) {
      throw new Error('Already at the last point of the route')
    }
    await this.app.activateRoute({
      href: route.href,
      reverse: route.reverse,
      pointIndex: route.pointIndex + 1
    })
  }

  async startRoute() {
    if (!this.cfg.route.enabled) throw new Error('Route following is disabled')
    if (this.routeHeading() === undefined) {
      throw new Error(
        'Route mode needs an active course with a track bearing and cross-track error'
      )
    }
    if (this.target === null && this.heading() === undefined && this.hscTarget === null) {
      throw new Error('Route mode needs navigation.headingMagnetic (AC10 HDG output)')
    }
    await this.engage()
    this.routeActive = true
    this.routeMissingSince = 0
    this.notifyRoute(false)
    this.publish()
    await this.routeTick()
  }

  // ---- internals -----------------------------------------------------------

  private async sendSteps(steps: number) {
    this.lastCommandTime = Date.now()
    await this.remote.steps(steps)
    if (this.target !== null) {
      // In WIND mode the target is the apparent wind angle, which moves the
      // opposite way to the bow
      this.target =
        this.status.state === 'wind'
          ? signedAngle(this.target - degToRad(steps))
          : compassAngle(this.target + degToRad(steps))
    }
    this.publish()
  }

  async routeTick() {
    if (!this.routeActive || this.routeBusy) return
    const desired = this.routeHeading()
    if (desired === undefined) {
      const now = Date.now()
      if (!this.routeMissingSince) this.routeMissingSince = now
      if (now - this.routeMissingSince >= this.cfg.route.dataTimeout * 1000) {
        // Holding the last course is safer than dropping to standby
        this.routeActive = false
        this.notifyRoute(true)
        this.publish()
      }
      return
    }
    this.routeMissingSince = 0
    if (this.target === null || this.remote.pendingSteps !== 0) return
    const error = radToDeg(angleDiff(desired, this.target))
    // Errors smaller than the deadband are ignored (tolerance for float noise)
    if (Math.abs(error) < Math.max(this.cfg.route.deadband, 0.5) - 1e-6) return
    const max = this.cfg.route.maxStepsPerCycle
    const steps = clamp(Math.round(error), -max, max)
    if (steps === 0) return
    this.routeBusy = true
    try {
      await this.sendSteps(steps)
    } catch (err) {
      this.app.error('route correction failed: ' + (err as Error).message)
    } finally {
      this.routeBusy = false
    }
  }

  private routeHeading(): number | undefined {
    const num = (p: string) => {
      const v = this.app.getSelfPath(p)
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    }
    const xte = num(P.xte)
    if (xte === undefined) return undefined
    const { xteLookahead, maxXteCorrection } = this.cfg.route
    const max = degToRad(maxXteCorrection)
    const trackTrue = num(P.trackTrue)
    const variation = num(P.variation)
    if (trackTrue !== undefined && variation !== undefined) {
      return compassAngle(routeHeading(trackTrue, xte, xteLookahead, max) - variation)
    }
    const trackMag = num(P.trackMagnetic)
    if (trackMag !== undefined) return routeHeading(trackMag, xte, xteLookahead, max)
    return undefined
  }

  private onHsc(value: number) {
    this.hscTarget = value
    this.hscTime = Date.now()
    // Ignore the AC10's echo while our own steps are still being applied
    const settling =
      this.remote.pendingSteps !== 0 || Date.now() - this.lastCommandTime < 3000
    if (this.remote.engaged === true && this.status.state !== 'wind' && !settling) {
      if (this.target === null || Math.abs(angleDiff(value, this.target)) > 1e-4) {
        this.target = compassAngle(value)
        this.publish()
      }
    }
  }

  private initTarget() {
    if (this.cfg.engagedMode === 'wind') {
      this.target = this.awa() ?? null
    } else {
      const hscFresh = Date.now() - this.hscTime < this.cfg.hscTimeout * 1000
      this.target = (hscFresh ? this.hscTarget : undefined) ?? this.heading() ?? null
    }
  }

  private heading() {
    const v = this.app.getSelfPath(P.heading)
    return typeof v === 'number' ? v : undefined
  }

  private awa() {
    const v = this.app.getSelfPath(P.awa)
    return typeof v === 'number' ? v : undefined
  }

  private requireRemote() {
    if (!this.remote.connected) {
      throw new Error('AC10 remote interface (ESPHome) is not connected')
    }
    if (this.remote.engaged === undefined) {
      throw new Error('AC10 autopilot state is unknown (no Lamp signal)')
    }
  }

  private requireEngaged() {
    this.requireRemote()
    if (this.remote.engaged !== true) throw new Error('Autopilot is not engaged')
  }

  private waitForEngaged(want: boolean): Promise<void> {
    if (this.remote.engaged === want) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remote.off('engaged', onChange)
        reject(new Error(`AC10 did not confirm ${want ? 'engage' : 'standby'} (Lamp did not change)`))
      }, this.cfg.confirmTimeout * 1000)
      const onChange = (engaged: boolean | undefined) => {
        if (engaged === want) {
          clearTimeout(timer)
          this.remote.off('engaged', onChange)
          resolve()
        }
      }
      this.remote.on('engaged', onChange)
    })
  }

  private publish(force = false) {
    const s = this.status
    const key = JSON.stringify(s)
    if (!force && key === this.lastPublished) return
    this.lastPublished = key
    const values: { path: string; value: unknown }[] = [
      { path: P.state, value: s.state },
      { path: P.engaged, value: s.engaged }
    ]
    if (s.state === 'wind') {
      values.push({ path: P.targetWind, value: s.target })
    } else {
      // null in standby so clients don't show a stale set course
      values.push({ path: P.targetHeading, value: s.engaged ? s.target : null })
    }
    this.app.handleMessage(this.sourceId, { updates: [{ values }] })
    this.emit('update', s)
  }

  private notifyRemote(ok: boolean) {
    this.notify(
      P.notifyRemote,
      ok ? null : 'AC10 remote interface offline: autopilot cannot be controlled',
      'alarm'
    )
  }

  private notifyRoute(lost: boolean) {
    this.notify(
      P.notifyRoute,
      lost ? 'Route data lost: AC10 is holding the last course in AUTO' : null,
      'alarm'
    )
  }

  private notify(path: string, message: string | null, state: string) {
    this.app.handleMessage(this.sourceId, {
      updates: [
        {
          values: [
            {
              path,
              value: message
                ? { state, method: ['visual', 'sound'], message }
                : { state: 'normal', method: [], message: '' }
            }
          ]
        }
      ]
    })
  }
}
