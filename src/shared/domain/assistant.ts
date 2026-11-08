/**
 * Mira is a global assistant, not another project supervisor.
 *
 * The durable thread is independent of repositories. Tasks created by Mira keep
 * `origin = 'supervisor'` (the existing approval class) and carry
 * `createdByActor = MIRA_ACTOR_ID` for accurate provenance and ownership.
 */

export const MIRA_ACTOR_ID = 'mira'
/** Written to `tasks.approved_by` when Mira's low-risk policy opens the gate. */
export const MIRA_POLICY_APPROVER = 'mira-policy'

export const ASSISTANT_ROLES = ['user', 'assistant', 'system', 'tool'] as const
export type AssistantRole = (typeof ASSISTANT_ROLES)[number]

export const ASSISTANT_MESSAGE_KINDS = [
  'text',
  'card',
  'status',
  'notification',
  'digest',
  'welcome',
  'error',
  'action'
] as const
export type AssistantMessageKind = (typeof ASSISTANT_MESSAGE_KINDS)[number]

export const ASSISTANT_PRIORITIES = ['high', 'normal', 'low'] as const
export type AssistantPriority = (typeof ASSISTANT_PRIORITIES)[number]

export const ASSISTANT_STATUSES = ['working', 'idle', 'offline', 'error'] as const
export type AssistantStatus = (typeof ASSISTANT_STATUSES)[number]

export const ASSISTANT_TRIGGERS = ['user', 'retry', 'proactive'] as const
export type AssistantTrigger = (typeof ASSISTANT_TRIGGERS)[number]

export const ASSISTANT_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
] as const
export type AssistantRunStatus = (typeof ASSISTANT_RUN_STATUSES)[number]

export const ASSISTANT_NOTIFICATION_STATES = ['pending', 'delivered', 'suppressed'] as const
export type AssistantNotificationState = (typeof ASSISTANT_NOTIFICATION_STATES)[number]

export const ASSISTANT_NOTIFICATION_KINDS = [
  'approval-needed',
  'task-waiting',
  'task-failed',
  'review-ready',
  'task-completed',
  'plan-ready',
  'task-created',
  'custom'
] as const
export type AssistantNotificationKind = (typeof ASSISTANT_NOTIFICATION_KINDS)[number]

export const ASSISTANT_LIMITS = {
  maxMessageLength: 4_000,
  maxNotificationLength: 500,
  maxThreadMessages: 100,
  maxPromptChars: 60_000,
  maxToolResultChars: 8_000,
  maxActionsPerRound: 5,
  maxHarnessCalls: 3,
  maxTaskCreatesPerRun: 2,
  maxSessionMessagesPerRun: 2,
  maxMemoryEntries: 50,
  maxMemoryKeyLength: 120,
  maxMemoryValueLength: 2_000
} as const

export type AssistantTarget =
  | { kind: 'auto' }
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string }

export type AssistantNotificationSettings = {
  enabled: boolean
  budgetPerHour: number
  quietMode: 'off' | 'in-app' | 'respect-hours'
  quietHours: { startMinute: number; endMinute: number }
}

export type AssistantAutoDispatchSettings = {
  mode: 'off' | 'low-risk' | 'all'
  dailyCapPerProject: number
  dailyCapGlobal: number
  maxTasksPerRun: number
  protectedKeywords: string[]
  protectedPaths: string[]
}

export type AssistantSettings = {
  personaName: string
  target: AssistantTarget
  harnessPriority: ('claude' | 'codex' | 'opencode')[]
  opencodeAgent: string
  notifications: AssistantNotificationSettings
  autoDispatch: AssistantAutoDispatchSettings
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  personaName: 'Mira',
  target: { kind: 'auto' },
  harnessPriority: ['claude', 'codex', 'opencode'],
  opencodeAgent: 'build',
  notifications: {
    enabled: true,
    budgetPerHour: 6,
    quietMode: 'respect-hours',
    quietHours: { startMinute: 22 * 60, endMinute: 8 * 60 }
  },
  autoDispatch: {
    mode: 'low-risk',
    dailyCapPerProject: 3,
    dailyCapGlobal: 10,
    maxTasksPerRun: 2,
    protectedKeywords: [
      'auth',
      'login',
      'password',
      'secret',
      'credential',
      'migration',
      'schema',
      'infra',
      'deploy',
      'release',
      'force-push',
      'merge',
      'production'
    ],
    protectedPaths: ['auth/', 'migrations/', '.github/', 'infra/', 'deploy/']
  }
}

export type AssistantThread = {
  id: string
  kind: 'main' | 'system'
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  lastReadSeq: number
  activeRunId: string | null
  archivedAt: number | null
}

export type AssistantCard =
  | {
      type: 'task'
      taskId: string
      repoId: string
      title: string
      status: string
      approval: 'approved' | 'pending' | 'rejected'
      autoApproved?: boolean
      reasons?: string[]
    }
  | {
      type: 'action'
      op: string
      ok: boolean
      message: string
      taskId?: string
    }
  | {
      type: 'notification'
      kind: AssistantNotificationKind
      text: string
      taskId?: string
      repoId?: string
    }
  | {
      type: 'error'
      message: string
    }

export type AssistantMessage = {
  id: string
  threadId: string
  seq: number
  runId: string | null
  role: AssistantRole
  kind: AssistantMessageKind
  body: string
  card: AssistantCard | null
  notificationKind: AssistantNotificationKind | null
  notificationPriority: AssistantPriority | null
  notificationState: AssistantNotificationState | null
  createdAt: number
}

export type AssistantRun = {
  id: string
  threadId: string
  trigger: AssistantTrigger
  status: AssistantRunStatus
  stage: string | null
  harness: 'claude' | 'codex' | 'opencode' | null
  targetKind: 'local' | 'wsl' | null
  targetDistro: string | null
  round: number
  contextChars: number | null
  startedAt: number
  finishedAt: number | null
  error: string | null
}

/** The visible stage of one Mira turn. */
export const ASSISTANT_RUN_STAGES = [
  'selecting',
  'calling',
  'thinking',
  'reading',
  'acting',
  'done'
] as const
export type AssistantRunStage = (typeof ASSISTANT_RUN_STAGES)[number]

export type AssistantActiveRun = {
  id: string
  stage: AssistantRunStage
  harness: string | null
  target: string | null
  round: number
  thinkingTokens: number | null
  startedAt: number
}

export type AssistantState = {
  threadId: string
  personaName: string
  unread: number
  status: AssistantStatus
  harness: string | null
  target: string | null
  /** Present while a turn is running, including after a renderer reload. */
  activeRun: AssistantActiveRun | null
  settings: AssistantSettings
}

export type AssistantEvent =
  | { type: 'changed' }
  | { type: 'status'; status: AssistantStatus }
  | { type: 'focus'; threadId: string; messageId: string }
  | {
      type: 'run'
      runId: string
      stage: AssistantRunStage
      harness: string | null
      target: string | null
      round: number
      thinkingTokens: number | null
      startedAt: number
    }
  | { type: 'delta'; runId: string; text: string }

export type AssistantActionOp =
  | 'state'
  | 'projects.list'
  | 'tasks.listAll'
  | 'tasks.get'
  | 'tasks.changes'
  | 'tasks.diff'
  | 'sessions.list'
  | 'tasks.create'
  | 'tasks.cancel'
  | 'tasks.retry'
  | 'tasks.archive'
  | 'sessions.message'
  | 'review.recommend'
  | 'notify'
  | 'memory.set'
  | 'memory.forget'

export type AssistantAction = {
  op: AssistantActionOp
  [key: string]: unknown
}
