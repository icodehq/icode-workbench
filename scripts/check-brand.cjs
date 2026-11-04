'use strict'

/**
 * Fails when an ADE/ade brand token appears outside this guard's own matching
 * pattern. Historical artifacts and generated build staging are excluded.
 */

const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative, sep } = require('node:path')

const root = join(__dirname, '..')
const roots = ['src', 'scripts', 'config']
const files = ['package.json', 'README.md', 'NOTICE', 'LICENSE']
const allowedPrefixes = []
const allowedFiles = new Set(['scripts/check-brand.cjs'])
const exts = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '.md', '.css', '.html', '.cmd', '.ps1', '.toml'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const candidates = []
for (const dir of roots) {
  try {
    candidates.push(...walk(join(root, dir)))
  } catch {
    // Optional directory.
  }
}
for (const file of files) candidates.push(join(root, file))

const pattern = /(?:\bADE\b|\bAde\b|\bade\b|\.ade\b|ade\/|ade\.sqlite|ade-|window\.ade|--ade-|__ade)/u
const violations = []
for (const path of candidates) {
  const rel = relative(root, path).split(sep).join('/')
  if (allowedFiles.has(rel) || allowedPrefixes.some((prefix) => rel.startsWith(prefix))) continue
  if (!exts.has(path.slice(path.lastIndexOf('.')))) continue
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) violations.push(`${rel}:${String(index + 1)}: ${line.trim()}`)
  }
}

if (violations.length > 0) {
  process.stderr.write(`[check:brand] unexpected ADE/ade tokens:\n${violations.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('[check:brand] no unexpected ADE/ade tokens\n')
