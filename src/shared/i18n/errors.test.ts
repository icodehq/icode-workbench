import { describe, expect, it } from 'vitest'
import { makeAppError } from '../domain/errors'
import { localizeAppError } from './errors'

describe('localizeAppError', () => {
  it('translates a keyed error and keeps diagnostics', () => {
    const error = makeAppError('INVALID_ARGUMENT', 'Invalid request payload.', {
      detail: 'path',
      messageKey: 'settings.language.description',
      messageParams: {}
    })
    const localized = localizeAppError(error, 'de')
    expect(localized.message).toContain('iCode Workbench')
    expect(localized.detail).toBe('path')
  })

  it('keeps the specific English message in English when no key is present', () => {
    const error = makeAppError('INVALID_ARGUMENT', 'Legacy persisted message.')
    expect(localizeAppError(error, 'en').message).toBe('Legacy persisted message.')
  })

  it('uses the code fallback in another locale when no key is present', () => {
    const error = makeAppError('INVALID_ARGUMENT', 'Legacy persisted message.')
    expect(localizeAppError(error, 'ja').message).toBe('リクエストが無効です。')
  })

  it('uses the generic fallback when the code has no catalog entry yet', () => {
    const error = makeAppError('GIT_STALE_STATUS', 'Legacy persisted message.')
    expect(localizeAppError(error, 'fr').message).toBe('Un problème est survenu.')
  })

  it('keeps the English message when a key no longer exists', () => {
    const error = {
      ...makeAppError('INTERNAL', 'Still valid English.'),
      messageKey: 'removed.key' as never
    }
    expect(localizeAppError(error, 'en').message).toBe('Still valid English.')
  })
})
