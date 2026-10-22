import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { SCROLLBACK_LINES, createEmulator, type Emulator } from './terminal-emulator'
import type { TerminalSnapshot } from '../shared/host-protocol'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

function dump(terminal: Terminal): {
  type: string
  cursor: { x: number; y: number }
  lines: string
} {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  return { type: buffer.type, cursor: { x: buffer.cursorX, y: buffer.cursorY }, lines: lines.join('|') }
}

/** Restore a snapshot into a fresh xterm, as a renderer would. */
async function restore(snapshot: TerminalSnapshot): Promise<Terminal> {
  const terminal = new Terminal({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true
  })
  terminal.loadAddon(new SerializeAddon())
  terminal.write(snapshot.data)
  await settle()
  return terminal
}

async function emulatorAfter(parts: string[], cols = 40, rows = 8): Promise<Emulator> {
  const emulator = createEmulator(cols, rows)
  for (const part of parts) emulator.write(part)
  await settle()
  return emulator
}

describe('terminal snapshots', () => {
  it('restores normal-screen text, ANSI colours, and cursor position', async () => {
    const emulator = await emulatorAfter([
      'hello\r\n',
      '\x1b[31mred\x1b[0m text\r\n',
      'third line',
      '\x1b[2;3H'
    ])
    const snapshot = emulator.snapshot(42)
    expect(snapshot).toMatchObject({
      cols: 40,
      rows: 8,
      seq: 42,
      alternateScreen: false,
      cursor: { x: 2, y: 1 },
      truncated: false
    })

    const restored = await restore(snapshot)
    expect(dump(restored)).toMatchObject({
      type: 'normal',
      cursor: { x: 2, y: 1 }
    })
    expect(dump(restored).lines).toContain('red text')
    expect(snapshot.data).toContain('\x1b[31m')
    restored.dispose()
    emulator.dispose()
  })

  it('restores alternate-screen content and screen type', async () => {
    const emulator = await emulatorAfter([
      'shell history\r\n',
      '\x1b[?1049h\x1b[2J\x1b[HTUI HEADER\r\n',
      '\x1b[2;3Hprompt >'
    ])
    const snapshot = emulator.snapshot(7)
    expect(snapshot.alternateScreen).toBe(true)

    const restored = await restore(snapshot)
    const state = dump(restored)
    expect(state.type).toBe('alternate')
    expect(state.cursor).toEqual(snapshot.cursor)
    expect(state.lines).toContain('TUI HEADER')
    restored.dispose()
    emulator.dispose()
  })

  it('returns to the normal screen after the TUI exits', async () => {
    const emulator = await emulatorAfter([
      '\x1b[?1049h\x1b[2J\x1b[HTUI',
      '\x1b[?1049lshell again'
    ])
    const snapshot = emulator.snapshot(3)
    expect(snapshot.alternateScreen).toBe(false)
    const restored = await restore(snapshot)
    expect(dump(restored).type).toBe('normal')
    expect(dump(restored).lines).toContain('shell again')
    restored.dispose()
    emulator.dispose()
  })

  it('keeps the cursor correct after a full-width row', async () => {
    const emulator = createEmulator(20, 6)
    emulator.write('ABCDEFGHIJKLMNOPQRST\r\nsecond\r\nthi')
    await settle()
    const snapshot = emulator.snapshot(1)
    const restored = await restore(snapshot)
    expect(dump(restored).cursor).toEqual(snapshot.cursor)
    expect(dump(restored).lines).toContain('second')
    restored.dispose()
    emulator.dispose()
  })

  it('bounds scrollback at 5,000 lines and marks truncation', async () => {
    const emulator = createEmulator(40, 6)
    const line = `${'x'.repeat(38)}\r\n`
    for (let i = 0; i < SCROLLBACK_LINES + 200; i += 1) emulator.write(line)
    // Let xterm drain in chunks so the pending counter is honest.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const snapshot = emulator.snapshot(9)
    expect(snapshot.scrollbackLines).toBeLessThanOrEqual(SCROLLBACK_LINES)
    expect(snapshot.truncated).toBe(true)
    emulator.dispose()
  })

  it('resizes dimensions in subsequent snapshots', async () => {
    const emulator = createEmulator(80, 24)
    emulator.write('before resize')
    await settle()
    emulator.resize(100, 30)
    const snapshot = emulator.snapshot(1)
    expect(snapshot).toMatchObject({ cols: 100, rows: 30 })
    emulator.dispose()
  })

  it('tracks pending bytes until xterm drains them', async () => {
    const emulator = createEmulator(80, 24)
    emulator.write('small')
    expect(emulator.pendingBytes()).toBeGreaterThanOrEqual(0)
    await settle()
    expect(emulator.pendingBytes()).toBe(0)
    emulator.dispose()
  })
})
