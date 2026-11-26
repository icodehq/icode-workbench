/**
 * A bot's own skills: one folder in its home, `skills/<name>/SKILL.md`. iCode
 * only manages this folder; a skill is text a bot can read, not executable code.
 *
 * Adapted from an MIT-licensed reference implementation (Copyright (c) 2026
 * Lovecast Inc.); see NOTICE.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { botHomeFolder } from './bot-home'
import { replaceTextFileSync } from './bot-home-write'

export type BotSkill = {
  name: string
  description: string
  folder: string
  updatedAt: number
}

const NAME = /^[a-z0-9][a-z0-9-]*$/

function skillDir(dataDir: string, botId: string, name: string): string {
  return join(botHomeFolder(dataDir, botId), 'skills', name)
}

/** The name and description a SKILL.md declares in its frontmatter, when it declares both. */
export function declaredSkillMetadata(
  markdown: string
): { name: string; description: string } | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(
    markdown.replace(/^﻿/, '')
  )
  if (!match) return null
  const read = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1] ?? '')?.[1]
    if (line === undefined) return null
    const value = line.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    return value.length > 0 ? value : null
  }
  const name = read('name')
  const description = read('description')
  return name !== null && description !== null ? { name, description } : null
}

function describe(name: string, text: string): { name: string; description: string } {
  const declared = declaredSkillMetadata(text)
  if (declared !== null) return declared
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('#') && !entry.startsWith('---'))
  return {
    name,
    description: line === undefined ? '' : line.slice(0, 300)
  }
}

export class BotSkillError extends Error {
  constructor(readonly code: 'SKILL_NAME' | 'SKILL_NOT_FOUND') {
    super(code)
  }
}

export class BotSkillService {
  constructor(private readonly dataDir: string) {}

  list(botId: string): BotSkill[] {
    const dir = join(botHomeFolder(this.dataDir, botId), 'skills')
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const skills: BotSkill[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue
      const file = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      try {
        const text = readFileSync(file, 'utf8')
        const meta = describe(entry.name, text)
        skills.push({
          name: meta.name,
          description: meta.description,
          folder: entry.name,
          updatedAt: 0
        })
      } catch {
        // A skill that cannot be read is not one.
      }
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name))
  }

  read(botId: string, folder: string): string | null {
    if (!NAME.test(folder)) return null
    try {
      return readFileSync(join(skillDir(this.dataDir, botId, folder), 'SKILL.md'), 'utf8')
    } catch {
      return null
    }
  }

  save(botId: string, folder: string, text: string): BotSkill {
    if (!NAME.test(folder)) throw new BotSkillError('SKILL_NAME')
    const dir = skillDir(this.dataDir, botId, folder)
    mkdirSync(dir, { recursive: true })
    const body = text.trim().length === 0 ? `# ${folder}\n` : text
    replaceTextFileSync(join(dir, 'SKILL.md'), body)
    const meta = describe(folder, body)
    return { name: meta.name, description: meta.description, folder, updatedAt: Date.now() }
  }

  remove(botId: string, folder: string): boolean {
    if (!NAME.test(folder)) return false
    const dir = skillDir(this.dataDir, botId, folder)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    return true
  }
}
