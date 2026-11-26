import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotSkillError, BotSkillService, declaredSkillMetadata } from './bot-skills'
import { botHomeFolder } from './bot-home'

let dataDir: string
let service: BotSkillService

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'icode-bot-skills-'))
  service = new BotSkillService(dataDir)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('bot skills', () => {
  it('saves a skill, lists its declared metadata and reads it back', () => {
    const text = [
      '---',
      'name: Deploy checklist',
      'description: What to check before a release',
      '---',
      '',
      '# Deploy',
      ''
    ].join('\n')
    const saved = service.save('bot_1', 'deploy', text)
    expect(saved).toMatchObject({
      name: 'Deploy checklist',
      description: 'What to check before a release',
      folder: 'deploy'
    })
    expect(readFileSync(join(botHomeFolder(dataDir, 'bot_1'), 'skills', 'deploy', 'SKILL.md'), 'utf8')).toBe(text)
    expect(service.list('bot_1')).toEqual([
      expect.objectContaining({ name: 'Deploy checklist', folder: 'deploy' })
    ])
    expect(service.read('bot_1', 'deploy')).toBe(text)
  })

  it('falls back to the folder and first prose line without frontmatter', () => {
    service.save('bot_1', 'notes', '# Notes\n\nHow to write release notes.\n')
    expect(service.list('bot_1')[0]).toMatchObject({
      name: 'notes',
      description: 'How to write release notes.'
    })
  })

  it('deletes a skill and rejects unsafe names', () => {
    service.save('bot_1', 'deploy', 'deploy')
    expect(service.remove('bot_1', 'deploy')).toBe(true)
    expect(service.list('bot_1')).toEqual([])
    expect(existsSync(join(botHomeFolder(dataDir, 'bot_1'), 'skills', 'deploy'))).toBe(false)
    expect(() => service.save('bot_1', '../escape', 'x')).toThrow(BotSkillError)
    expect(service.read('bot_1', '../escape')).toBeNull()
  })

  it('parses quoted frontmatter values', () => {
    expect(
      declaredSkillMetadata('---\nname: "Deploy"\ndescription: "Ship it"\n---\n')
    ).toEqual({ name: 'Deploy', description: 'Ship it' })
    expect(declaredSkillMetadata('no frontmatter')).toBeNull()
  })
})
