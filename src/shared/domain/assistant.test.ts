import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_SIDE_CHAT_TITLE_LENGTH,
  assistantThreadTitleFromText
} from './assistant'

describe('assistant thread titles', () => {
  it('uses the first non-empty line and normalizes whitespace', () => {
    expect(assistantThreadTitleFromText('\n  Fix   the parser \nThen add tests')).toBe(
      'Fix the parser'
    )
    expect(assistantThreadTitleFromText('   \n\t')).toBeNull()
  })

  it('clips a long title at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(30).trim()
    const title = assistantThreadTitleFromText(long)
    expect(title).not.toBeNull()
    expect(title!.length).toBeLessThanOrEqual(ASSISTANT_SIDE_CHAT_TITLE_LENGTH + 1)
    expect(title!.endsWith('…')).toBe(true)
  })
})
