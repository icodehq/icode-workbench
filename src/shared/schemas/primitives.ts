import { z } from 'zod'
import { INCARNATION_ID_RE, REPO_ID_RE, SESSION_ID_RE, WORKSPACE_ID_RE } from '../domain/ids'
import { MAX_PATH_LENGTH, isAbsolutePathLike } from '../domain/paths'
import { MAX_SESSION_TITLE_LENGTH } from '../domain/session'

/** Opaque IDs on the host wire: the host must not depend on ADE ID formats. */
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
