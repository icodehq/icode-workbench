'use strict'

/**
 * Regenerate the packaged app icons from the brand mark.
 *
 * Why: the installer, executable and desktop entries read the binary assets in
 * `resources/build`, not `.github/assets/logo.svg`. Without this step a logo
 * change in the README leaves the black-tile artwork in every package.
 *
 * The script is dependency-free: it rasterizes the SVG's simple path/rect
 * shapes with supersampled scanline coverage, then writes PNG, ICO and ICNS
 * containers. Run it after editing the logo:
 *
 *   node config/scripts/generate-icons.cjs
 */

const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { deflateSync } = require('node:zlib')

const ROOT = resolve(__dirname, '..', '..')
const LOGO_PATH = join(ROOT, '.github', 'assets', 'logo.svg')
const BUILD_DIR = join(ROOT, 'resources', 'build')
const VIEWBOX = 128

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** type, pixels, purpose (modern PNG-compressed ICNS entries). */
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512]
]

// ---------------------------------------------------------------------------
// SVG parsing

function parsePath(d) {
  const tokens = d.match(/[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []
  const points = []
  let command = null
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]
    if (/[A-Za-z]/.test(token)) {
      command = token
      index += 1
      if (command === 'Z' || command === 'z') continue
      if (command !== 'M' && command !== 'L') {
        throw new Error(`generate-icons: unsupported SVG path command "${command}"`)
      }
      continue
    }
    if (command !== 'M' && command !== 'L') {
      throw new Error('generate-icons: SVG path coordinates without an M/L command')
    }
    const x = Number(tokens[index])
    const y = Number(tokens[index + 1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('generate-icons: malformed SVG path coordinates')
    }
    points.push([x, y])
    index += 2
  }

  if (points.length < 3) throw new Error('generate-icons: SVG path needs at least three points')
  return points
}

function numberAttribute(element, name, fallback = 0) {
  const match = element.match(new RegExp(`\\b${name}="([^"]+)"`))
  return match ? Number(match[1]) : fallback
}

function parseShapes(svg) {
  const shapes = []
  for (const match of svg.matchAll(/<(path|rect)\b[^>]*>/g)) {
    const element = match[0]
    const fill = element.match(/\bfill="(#[0-9a-fA-F]{6})"/)
    if (!fill) throw new Error('generate-icons: every shape needs an #rrggbb fill')

    if (match[1] === 'path') {
      const d = element.match(/\bd="([^"]+)"/)
      if (!d) throw new Error('generate-icons: path element without d')
      shapes.push({ kind: 'polygon', points: parsePath(d[1]), fill: fill[1] })
    } else {
      shapes.push({
        kind: 'rect',
        x: numberAttribute(element, 'x'),
        y: numberAttribute(element, 'y'),
        width: numberAttribute(element, 'width'),
        height: numberAttribute(element, 'height'),
        radius: numberAttribute(element, 'rx', 0),
        fill: fill[1]
      })
    }
  }
  if (shapes.length === 0) throw new Error('generate-icons: no path or rect shapes found')
  return shapes
}

function parseColor(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}

// ---------------------------------------------------------------------------
// Rasterization

/**
 * Adds the horizontal extent [x0, x1) of one sub-row to a coverage buffer.
 * Horizontal overlap is exact; vertical coverage comes from the sub-row count.
 */
function addSpan(coverage, rowOffset, size, x0, x1, weight) {
  if (!(x1 > x0) || x1 <= 0 || x0 >= size) return
  const left = Math.max(0, x0)
  const right = Math.min(size, x1)
  const first = Math.floor(left)
  const last = Math.floor(right)

  if (first === last) {
    coverage[rowOffset + first] += (right - left) * weight
    return
  }
  coverage[rowOffset + first] += (first + 1 - left) * weight
  for (let pixel = first + 1; pixel < last; pixel += 1) {
    coverage[rowOffset + pixel] += weight
  }
  if (last < size) coverage[rowOffset + last] += (right - last) * weight
}

function rasterizePolygon(points, size, subSamples) {
  const coverage = new Float32Array(size * size)
  const weight = 1 / subSamples

  for (let row = 0; row < size; row += 1) {
    for (let sub = 0; sub < subSamples; sub += 1) {
      const y = row + (sub + 0.5) / subSamples
      const crossings = []
      for (let edge = 0; edge < points.length; edge += 1) {
        const [x1, y1] = points[edge]
        const [x2, y2] = points[(edge + 1) % points.length]
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1))
        }
      }
      crossings.sort((a, b) => a - b)
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        addSpan(coverage, row * size, size, crossings[index], crossings[index + 1], weight)
      }
    }
  }
  return coverage
}

function rasterizeRoundRect(rect, size, subSamples) {
  const coverage = new Float32Array(size * size)
  const weight = 1 / subSamples
  const { x, y, width, height } = rect
  const radius = Math.min(rect.radius, width / 2, height / 2)

  for (let row = 0; row < size; row += 1) {
    for (let sub = 0; sub < subSamples; sub += 1) {
      const scanY = row + (sub + 0.5) / subSamples
      if (scanY < y || scanY > y + height) continue

      let left
      let right
      if (scanY >= y + radius && scanY <= y + height - radius) {
        left = x
        right = x + width
      } else {
        const capY = scanY < y + radius ? y + radius : y + height - radius
        const dy = Math.abs(scanY - capY)
        const dx = Math.sqrt(Math.max(0, radius * radius - dy * dy))
        left = x + radius - dx
        right = x + width - radius + dx
      }
      addSpan(coverage, row * size, size, left, right, weight)
    }
  }
  return coverage
}

function composite(target, coverage, color) {
  const [red, green, blue] = color
  for (let pixel = 0; pixel < coverage.length; pixel += 1) {
    const alpha = Math.min(1, coverage[pixel])
    if (alpha <= 0) continue
    const offset = pixel * 4
    const inverse = 1 - alpha
    target[offset] = Math.round(red * alpha + target[offset] * inverse)
    target[offset + 1] = Math.round(green * alpha + target[offset + 1] * inverse)
    target[offset + 2] = Math.round(blue * alpha + target[offset + 2] * inverse)
    target[offset + 3] = Math.round(255 * alpha + target[offset + 3] * inverse)
  }
}

function render(size, shapes) {
  const scale = size / VIEWBOX
  const subSamples = size <= 128 ? 16 : 8
  const pixels = new Uint8ClampedArray(size * size * 4)

  for (const shape of shapes) {
    let coverage
    if (shape.kind === 'polygon') {
      coverage = rasterizePolygon(
        shape.points.map(([x, y]) => [x * scale, y * scale]),
        size,
        subSamples
      )
    } else {
      coverage = rasterizeRoundRect(
        {
          x: shape.x * scale,
          y: shape.y * scale,
          width: shape.width * scale,
          height: shape.height * scale,
          radius: shape.radius * scale
        },
        size,
        subSamples
      )
    }
    composite(pixels, coverage, parseColor(shape.fill))
  }
  return pixels
}

// ---------------------------------------------------------------------------
// PNG / ICO / ICNS encoders

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[value] = crc >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, checksum])
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let row = 0; row < size; row += 1) {
    const target = row * (stride + 1)
    raw[target] = 0 // filter: none
    Buffer.from(pixels.buffer, row * stride, stride).copy(raw, target + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  const data = []
  let offset = header.length + entries.length
  images.forEach(({ size, png }, index) => {
    const entry = index * 16
    entries[entry] = size >= 256 ? 0 : size
    entries[entry + 1] = size >= 256 ? 0 : size
    entries[entry + 2] = 0
    entries[entry + 3] = 0
    entries.writeUInt16LE(1, entry + 4)
    entries.writeUInt16LE(32, entry + 6)
    entries.writeUInt32LE(png.length, entry + 8)
    entries.writeUInt32LE(offset, entry + 12)
    offset += png.length
    data.push(png)
  })

  return Buffer.concat([header, entries, ...data])
}

function encodeIcns(images) {
  const chunks = images.map(({ type, png }) => {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const total = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total, 4)
  return Buffer.concat([header, ...chunks])
}

// ---------------------------------------------------------------------------
// Main

function main() {
  const svg = readFileSync(LOGO_PATH, 'utf8')
  const shapes = parseShapes(svg)

  const rendered = new Map()
  const renderSize = (size) => {
    if (!rendered.has(size)) {
      rendered.set(size, { size, png: encodePng(size, render(size, shapes)) })
    }
    return rendered.get(size)
  }

  for (const size of PNG_SIZES) {
    writeFileSync(join(BUILD_DIR, 'icons', `${size}x${size}.png`), renderSize(size).png)
  }
  writeFileSync(join(BUILD_DIR, 'icon.png'), renderSize(1024).png)
  writeFileSync(join(BUILD_DIR, 'icon.ico'), encodeIco(ICO_SIZES.map(renderSize)))
  writeFileSync(
    join(BUILD_DIR, 'icon.icns'),
    encodeIcns(ICNS_ENTRIES.map(([type, size]) => ({ type, png: renderSize(size).png })))
  )

  process.stdout.write(
    `[icons] regenerated ${PNG_SIZES.length} PNGs, icon.ico and icon.icns from ${LOGO_PATH}\n`
  )
}

main()
