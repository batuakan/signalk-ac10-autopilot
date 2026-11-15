// Bundles the vendored signalk-autopilot remote GUI without webpack: the
// source is one ES module, exposed to index.html as the global `autopilot`.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const src = readFileSync('public-src/js/signalk-autopilot.js', 'utf8')
const names = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1])
const body = src.replace(/^export function /gm, 'function ')
writeFileSync(
  'public/signalk-autopilot.min.js',
  `var autopilot = (function () {\n${body}\nreturn { ${names.join(', ')} }\n})()\n`
)
copyFileSync('public-src/index.html', 'public/index.html')
console.log(`GUI built, exports: ${names.join(', ')}`)
