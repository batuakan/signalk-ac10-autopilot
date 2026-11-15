export const degToRad = (d: number) => (d * Math.PI) / 180
export const radToDeg = (r: number) => (r * 180) / Math.PI

/** Normalise to [0, 2π) */
export function compassAngle(angle: number) {
  const twoPi = 2 * Math.PI
  return ((angle % twoPi) + twoPi) % twoPi
}

/** Normalise to (-π, π] */
export function signedAngle(angle: number) {
  const a = compassAngle(angle)
  return a > Math.PI ? a - 2 * Math.PI : a
}

/** Shortest signed turn from `from` to `to`, radians, positive = starboard */
export function angleDiff(to: number, from: number) {
  return signedAngle(to - from)
}

export const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), max)

/**
 * Heading that follows the route leg: track bearing corrected for cross-track
 * error. Same law as the signalk-autopilot emulator: an XTE equal to the
 * lookahead distance gives a 45° correction, limited to ±maxCorrection.
 * Signal K XTE is positive when the vessel is right (starboard) of track.
 */
export function routeHeading(
  trackBearing: number,
  xte: number,
  lookahead: number,
  maxCorrection: number
) {
  const correction = clamp(
    -Math.atan(xte / lookahead),
    -maxCorrection,
    maxCorrection
  )
  return compassAngle(trackBearing + correction)
}
