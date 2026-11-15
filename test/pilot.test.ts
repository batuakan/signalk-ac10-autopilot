import { expect } from 'chai'
import { deg, makePilot, toDeg } from './helpers'

describe('AC10Pilot', () => {
  let ctx: ReturnType<typeof makePilot>
  afterEach(() => ctx?.pilot.stop())

  describe('state', () => {
    it('reports standby from the Lamp and unknown without it', () => {
      ctx = makePilot()
      expect(ctx.pilot.status.state).to.equal('standby')
      ctx.remote.setEngaged(undefined)
      expect(ctx.pilot.status.state).to.equal(null)
    })

    it('engages AUTO with the current heading as target', async () => {
      ctx = makePilot()
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(123)
      await ctx.pilot.setState('auto')
      expect(ctx.remote.presses).to.deep.equal(['engage'])
      expect(ctx.pilot.status).to.include({ state: 'auto', engaged: true })
      expect(toDeg(ctx.pilot.status.target!)).to.equal(123)
      expect(ctx.app.last('steering.autopilot.state')).to.equal('auto')
    })

    it('prefers a fresh HSC set course from the AC10', async () => {
      ctx = makePilot()
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(123)
      ctx.app.emitBus('steering.autopilot.target.headingMagnetic', deg(130))
      await ctx.pilot.setState('auto')
      expect(toDeg(ctx.pilot.status.target!)).to.equal(130)
    })

    it('does not press the toggle when already in the requested state', async () => {
      ctx = makePilot()
      await ctx.pilot.setState('standby')
      ctx.remote.setEngaged(true)
      await ctx.pilot.setState('auto')
      expect(ctx.remote.presses).to.deep.equal([])
    })

    it('fails when the Lamp does not confirm', async () => {
      ctx = makePilot()
      ctx.remote.respond = false
      let err: Error | undefined
      await ctx.pilot.setState('auto').catch((e) => (err = e))
      expect(err?.message).to.match(/did not confirm engage/)
    })

    it('rejects a mode the remote key cannot select', async () => {
      ctx = makePilot()
      let err: Error | undefined
      await ctx.pilot.setState('wind').catch((e) => (err = e))
      expect(err?.message).to.match(/engages AUTO/)
      expect(ctx.remote.presses).to.deep.equal([])
    })

    it('refuses commands when the ESPHome device is offline', async () => {
      ctx = makePilot()
      ctx.remote.connected = false
      let err: Error | undefined
      await ctx.pilot.setState('auto').catch((e) => (err = e))
      expect(err?.message).to.match(/not connected/)
    })

    it('goes to standby', async () => {
      ctx = makePilot()
      ctx.remote.setEngaged(true)
      await ctx.pilot.setState('standby')
      expect(ctx.remote.presses).to.deep.equal(['standby'])
      expect(ctx.pilot.status.state).to.equal('standby')
    })
  })

  describe('course changes', () => {
    it('refuses to step while in standby (would be NFU rudder)', async () => {
      ctx = makePilot()
      let err: Error | undefined
      await ctx.pilot.adjust(10).catch((e) => (err = e))
      expect(err?.message).to.match(/not engaged/)
      expect(ctx.remote.sentSteps).to.deep.equal([])
    })

    it('adjusts heading in 1° steps and tracks the target', async () => {
      ctx = makePilot()
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(355)
      await ctx.pilot.setState('auto')
      await ctx.pilot.adjust(10)
      await ctx.pilot.adjust(-1)
      expect(ctx.remote.sentSteps).to.deep.equal([10, -1])
      expect(toDeg(ctx.pilot.status.target!)).to.equal(4)
    })

    it('limits a single adjustment', async () => {
      ctx = makePilot({ maxAdjust: 20 })
      ctx.remote.setEngaged(true)
      let err: Error | undefined
      await ctx.pilot.adjust(30).catch((e) => (err = e))
      expect(err?.message).to.match(/exceeds/)
    })

    it('sets an absolute heading by the shortest turn', async () => {
      ctx = makePilot()
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(350)
      await ctx.pilot.setState('auto')
      await ctx.pilot.setTargetHeading(deg(10))
      expect(ctx.remote.sentSteps).to.deep.equal([20])
    })

    it('tacks in AUTO by the configured angle', async () => {
      ctx = makePilot({ tackAngle: 100 })
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(90)
      await ctx.pilot.setState('auto')
      await ctx.pilot.tack('port')
      expect(ctx.remote.sentSteps).to.deep.equal([-100])
      expect(toDeg(ctx.pilot.status.target!)).to.equal(350)
    })

    it('ignores the AC10 HSC echo while steps settle, then follows it', async () => {
      ctx = makePilot()
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(100)
      await ctx.pilot.setState('auto')
      await ctx.pilot.adjust(10)
      ctx.app.emitBus('steering.autopilot.target.headingMagnetic', deg(100))
      expect(toDeg(ctx.pilot.status.target!)).to.equal(110)
      // Our own published value is never treated as AC10 data
      ctx.app.emitBus('steering.autopilot.target.headingMagnetic', deg(1), 'ac10-autopilot')
      expect(toDeg(ctx.pilot.status.target!)).to.equal(110)
    })
  })

  describe('wind mode', () => {
    it('engages WIND and inverts the wind target for course steps', async () => {
      ctx = makePilot({ engagedMode: 'wind' })
      ctx.app.paths['environment.wind.angleApparent.value'] = deg(40)
      await ctx.pilot.setState('wind')
      expect(ctx.pilot.status.state).to.equal('wind')
      await ctx.pilot.adjust(5) // wind on starboard: turning to starboard luffs up
      expect(toDeg(ctx.pilot.status.target!)).to.equal(35)
      expect(toDeg(ctx.app.last('steering.autopilot.target.windAngleApparent') as number)).to.equal(35)
    })

    it('sets a wind angle', async () => {
      ctx = makePilot({ engagedMode: 'wind' })
      ctx.app.paths['environment.wind.angleApparent.value'] = deg(40)
      await ctx.pilot.setState('wind')
      await ctx.pilot.setTargetWind(deg(50))
      expect(ctx.remote.sentSteps).to.deep.equal([-10])
    })

    it('tacks through the wind and refuses a gybe', async () => {
      ctx = makePilot({ engagedMode: 'wind' })
      ctx.app.paths['environment.wind.angleApparent.value'] = deg(40)
      await ctx.pilot.setState('wind')
      let err: Error | undefined
      await ctx.pilot.tack('port').catch((e) => (err = e))
      expect(err?.message).to.match(/would gybe/)
      await ctx.pilot.tack('starboard')
      expect(ctx.remote.sentSteps).to.deep.equal([80])
      expect(toDeg(ctx.pilot.status.target!)).to.equal(-40)
    })
  })

  describe('route', () => {
    const setCourse = (app: ReturnType<typeof makePilot>['app'], track: number, xte: number) => {
      app.paths['navigation.course.calcValues.bearingTrackMagnetic.value'] = deg(track)
      app.paths['navigation.course.calcValues.crossTrackError.value'] = xte
    }

    it('needs course data', async () => {
      ctx = makePilot()
      let err: Error | undefined
      await ctx.pilot.setState('route').catch((e) => (err = e))
      expect(err?.message).to.match(/active course/)
      expect(ctx.remote.presses).to.deep.equal([])
    })

    it('engages and steps toward the track, limited per cycle', async () => {
      ctx = makePilot({}, { maxStepsPerCycle: 3 })
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(80)
      setCourse(ctx.app, 90, 0)
      await ctx.pilot.setState('route')
      expect(ctx.pilot.status.state).to.equal('route')
      expect(ctx.remote.sentSteps).to.deep.equal([3])
      await ctx.pilot.routeTick()
      await ctx.pilot.routeTick()
      await ctx.pilot.routeTick()
      expect(ctx.remote.sentSteps).to.deep.equal([3, 3, 3, 1])
      await ctx.pilot.routeTick()
      expect(ctx.remote.sentSteps.length).to.equal(4)
    })

    it('corrects for cross-track error (right of track -> steer to port)', async () => {
      ctx = makePilot({}, { maxStepsPerCycle: 90 })
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(90)
      setCourse(ctx.app, 90, 100) // 100 m right of track, lookahead 100 m -> 45°
      await ctx.pilot.setState('route')
      expect(ctx.remote.sentSteps).to.deep.equal([-45])
    })

    it('holds the course in AUTO and alarms when course data disappears', async () => {
      ctx = makePilot({}, { dataTimeout: 0 })
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(90)
      setCourse(ctx.app, 90, 0)
      await ctx.pilot.setState('route')
      delete ctx.app.paths['navigation.course.calcValues.crossTrackError.value']
      await ctx.pilot.routeTick()
      expect(ctx.pilot.status.state).to.equal('auto')
      expect(ctx.remote.presses).to.deep.equal(['engage'])
      const n = ctx.app.last('notifications.autopilot.routeDataLost') as { state: string }
      expect(n.state).to.equal('alarm')
    })

    it('a manual adjustment leaves route for AUTO', async () => {
      ctx = makePilot()
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(90)
      setCourse(ctx.app, 90, 0)
      await ctx.pilot.setState('route')
      await ctx.pilot.adjust(-10)
      expect(ctx.pilot.status.state).to.equal('auto')
    })

    it('stops following when the AC10 is put in standby at the control unit', async () => {
      ctx = makePilot()
      ctx.app.paths['navigation.headingMagnetic.value'] = deg(90)
      setCourse(ctx.app, 90, 0)
      await ctx.pilot.setState('route')
      ctx.remote.setEngaged(false)
      ctx.remote.setEngaged(true)
      expect(ctx.pilot.status.state).to.equal('auto')
    })

    it('advances to the next route point', async () => {
      ctx = makePilot()
      ctx.app.course = { activeRoute: { href: '/r/1', pointIndex: 1, pointTotal: 4, reverse: false } }
      await ctx.pilot.nextPoint()
      expect(ctx.app.activated).to.deep.equal([{ href: '/r/1', reverse: false, pointIndex: 2 }])
    })
  })

  it('raises an alarm while the remote interface is offline', () => {
    ctx = makePilot()
    ctx.remote.emit('disconnected', 'gone')
    const n = ctx.app.last('notifications.autopilot.remoteOffline') as { state: string }
    expect(n.state).to.equal('alarm')
    ctx.remote.emit('connected')
    expect((ctx.app.last('notifications.autopilot.remoteOffline') as { state: string }).state).to.equal('normal')
  })
})
