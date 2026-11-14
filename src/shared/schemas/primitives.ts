import { z } from 'zod'
import {
  INCARNATION_ID_RE,
  REPO_ID_RE,
  SESSION_ID_RE,
  WORKSPACE_ID_RE,
  WORKTREE_ID_RE
} from '../domain/ids'
import { MAX_PATH_LENGTH, isAbsolutePathLike } from '../domain/paths'
import { MAX_SESSION_TITLE_LENGTH } from '../domain/session'

/** Opaque IDs on the host wire: the host must not depend on iCode ID formats. */
export const wireIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must contain only [A-Za-z0-9._:-]')

export const wireSessionIdSchema = wireIdSchema
export const wireIncarnationIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/)

export const repoIdSchema = z.string().regex(REPO_ID_RE, 'must be a repo_<uuid> identifier')
export const workspaceIdSchema = z
  .string()
  .regex(WORKSPACE_ID_RE, 'must be a ws_<uuid> identifier')
export const sessionIdSchema = z.string().regex(SESSION_ID_RE, 'must be a ses_<uuid> identifier')
export const worktreeIdSchema = z
  .string()
  .regex(WORKTREE_ID_RE, 'must be a wt_<uuid> identifier')
export const incarnationIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(INCARNATION_ID_RE, 'must be an opaque incarnation identifier')
  .refine((value) => !value.startsWith('ses_'), 'must not look like a durable session ID')

export const absolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine(isAbsolutePathLike, 'must be an absolute path')

/**
 * A path relative to a worktree. The renderer only echoes paths it received
 * from a validated listing; main re-validates every request: no absolute paths,
 * no `..`, no NUL, no leading `-` (which Git would read as an option), and no
 * drive/UNC prefixes.
 */
export const worktreeRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\u0000'), 'must not contain NUL')
  .refine((value) => !value.startsWith('-'), 'must not start with a dash')
  .refine((value) => !value.startsWith('/'), 'must be relative to the worktree')
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), 'must not be a drive path')
  .refine((value) => !value.startsWith('\\\\'), 'must not be a UNC path')
  .refine(
    (value) => !value.split(/[\\/]/u).some((segment) => segment === '..'),
    'must not contain a parent segment'
  )

export const dimensionSchema = z.number().int().min(1).max(1000)
export const timestampSchema = z.number().int().nonnegative()

export const sessionTitleSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_TITLE_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters')

/** Renderer/host terminal input, bounded by UTF-8 bytes. */
export const terminalInputSchema = z
  .string()
  .max(1_100_000)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576, {
    message: 'must be at most 1 MiB'
  })

export const errorMessageSchema = z.string().min(1).max(500)
export const errorDetailSchema = z.string().max(4000)
export const diagnosticTextSchema = z.string().max(2000)
