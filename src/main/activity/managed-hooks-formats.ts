/**
 * Managed-hook format adapters.
 *
 * Provider metadata decides which format a CLI uses; this map decides which
 * installer implements it. The exhaustive records make a new format a compile
 * error until both the local and guest sides are wired.
 */

import type { ManagedHookFormat, ManagedHookProvider } from '../../shared/domain/managed-hook-providers'
import {
  installManagedHooksForProvider,
  managedHooksStatus,
  removeManagedHooksForProvider,
  type ManagedHookInstallOptions,
  type ManagedHookProviderStatus,
  type ManagedHookRuntime
} from './managed-hooks'
import {
  installGuestManagedHooks,
  guestManagedHooksStatus,
  removeGuestManagedHooks,
  type GuestManagedHookOptions
} from './managed-hooks-guest'
import {
  installGuestKimiHooks,
  installLocalKimiHooks,
  guestKimiStatus,
  localKimiStatus,
  removeGuestKimiHooks,
  removeLocalKimiHooks
} from './managed-hooks-kimi'
import {
  guestAmpStatus,
  installGuestAmpHooks,
  installLocalAmpHooks,
  localAmpStatus,
  removeGuestAmpHooks,
  removeLocalAmpHooks
} from './managed-hooks-amp'
import {
  guestJsoncStatus,
  installGuestJsoncHooks,
  installLocalJsoncHooks,
  localJsoncStatus,
  removeGuestJsoncHooks,
  removeLocalJsoncHooks
} from './managed-hooks-jsonc'
import {
  guestAntigravityStatus,
  installGuestAntigravityHooks,
  installLocalAntigravityHooks,
  localAntigravityStatus,
  removeGuestAntigravityHooks,
  removeLocalAntigravityHooks
} from './managed-hooks-antigravity'
import {
  guestMuseStatus,
  installGuestMuseHooks,
  installLocalMuseHooks,
  localMuseStatus,
  removeGuestMuseHooks,
  removeLocalMuseHooks
} from './managed-hooks-muse'
import {
  guestKiroStatus,
  installGuestKiroHooks,
  installLocalKiroHooks,
  localKiroStatus,
  removeGuestKiroHooks,
  removeLocalKiroHooks
} from './managed-hooks-kiro'
import {
  guestJcodeStatus,
  installGuestJcodeHooks,
  installLocalJcodeHooks,
  localJcodeStatus,
  removeGuestJcodeHooks,
  removeLocalJcodeHooks
} from './managed-hooks-jcode'
import {
  guestDshStatus,
  installGuestDshHooks,
  installLocalDshHooks,
  localDshStatus,
  removeGuestDshHooks,
  removeLocalDshHooks
} from './managed-hooks-dsh'
import {
  guestHermesStatus,
  installGuestHermesHooks,
  installLocalHermesHooks,
  localHermesStatus,
  removeGuestHermesHooks,
  removeLocalHermesHooks
} from './managed-hooks-hermes'

export type LocalHookContext = {
  options: ManagedHookInstallOptions
  /** Creates the shared hook script on first use. */
  runtime: () => ManagedHookRuntime
}

export type LocalHookAdapter = {
  status(provider: ManagedHookProvider, context: LocalHookContext): ManagedHookProviderStatus
  install(provider: ManagedHookProvider, context: LocalHookContext): ManagedHookProviderStatus
  remove(provider: ManagedHookProvider, context: LocalHookContext): ManagedHookProviderStatus
}

export type GuestHookAdapter = {
  status(options: GuestManagedHookOptions): Promise<ManagedHookProviderStatus>
  install(options: GuestManagedHookOptions): Promise<ManagedHookProviderStatus>
  remove(options: GuestManagedHookOptions): Promise<ManagedHookProviderStatus>
}

export const LOCAL_HOOK_ADAPTERS: Record<ManagedHookFormat, LocalHookAdapter> = {
  json: {
    status: (provider, context) =>
      managedHooksStatus(provider, context.options, context.runtime()),
    install: (provider, context) =>
      installManagedHooksForProvider(provider, context.options, context.runtime()),
    remove: (provider, context) =>
      removeManagedHooksForProvider(provider, context.options, context.runtime())
  },
  jsonc: {
    status: (provider, context) =>
      localJsoncStatus(provider, context.options, context.runtime()),
    install: (provider, context) =>
      installLocalJsoncHooks(provider, context.options, context.runtime()),
    remove: (provider, context) =>
      removeLocalJsoncHooks(provider, context.options, context.runtime())
  },
  zcode: {
    status: (provider, context) =>
      localJsoncStatus(provider, context.options, context.runtime()),
    install: (provider, context) =>
      installLocalJsoncHooks(provider, context.options, context.runtime()),
    remove: (provider, context) =>
      removeLocalJsoncHooks(provider, context.options, context.runtime())
  },
  antigravity: {
    status: (_provider, context) => localAntigravityStatus(context.options, context.runtime()),
    install: (_provider, context) =>
      installLocalAntigravityHooks(context.options, context.runtime()),
    remove: (_provider, context) =>
      removeLocalAntigravityHooks(context.options, context.runtime())
  },
  muse: {
    status: (_provider, context) => localMuseStatus(context.options, context.runtime()),
    install: (_provider, context) => installLocalMuseHooks(context.options, context.runtime()),
    remove: (_provider, context) => removeLocalMuseHooks(context.options, context.runtime())
  },
  kiro: {
    status: (_provider, context) => localKiroStatus(context.options, context.runtime()),
    install: (_provider, context) => installLocalKiroHooks(context.options, context.runtime()),
    remove: (_provider, context) => removeLocalKiroHooks(context.options, context.runtime())
  },
  'jcode-toml': {
    status: (_provider, context) => localJcodeStatus(context.options, context.runtime()),
    install: (_provider, context) => installLocalJcodeHooks(context.options, context.runtime()),
    remove: (_provider, context) => removeLocalJcodeHooks(context.options, context.runtime())
  },
  dsh: {
    status: (_provider, context) => localDshStatus(context.options, context.runtime()),
    install: (_provider, context) => installLocalDshHooks(context.options, context.runtime()),
    remove: (_provider, context) => removeLocalDshHooks(context.options, context.runtime())
  },
  hermes: {
    status: (_provider, context) => localHermesStatus(context.options),
    install: (_provider, context) => installLocalHermesHooks(context.options),
    remove: (_provider, context) => removeLocalHermesHooks(context.options)
  },
  'kimi-toml': {
    status: (provider, context) => localKimiStatus(provider, context.options),
    install: (provider, context) =>
      installLocalKimiHooks(provider, context.options, context.runtime()),
    remove: (provider, context) => removeLocalKimiHooks(provider, context.options)
  },
  'amp-plugin': {
    status: (provider, context) => localAmpStatus(provider, context.options),
    install: (provider, context) => installLocalAmpHooks(provider, context.options),
    remove: (provider, context) => removeLocalAmpHooks(provider, context.options)
  }
}

export const GUEST_HOOK_ADAPTERS: Record<ManagedHookFormat, GuestHookAdapter> = {
  json: {
    status: guestManagedHooksStatus,
    install: installGuestManagedHooks,
    remove: removeGuestManagedHooks
  },
  jsonc: {
    status: guestJsoncStatus,
    install: installGuestJsoncHooks,
    remove: removeGuestJsoncHooks
  },
  zcode: {
    status: guestJsoncStatus,
    install: installGuestJsoncHooks,
    remove: removeGuestJsoncHooks
  },
  antigravity: {
    status: guestAntigravityStatus,
    install: installGuestAntigravityHooks,
    remove: removeGuestAntigravityHooks
  },
  muse: {
    status: guestMuseStatus,
    install: installGuestMuseHooks,
    remove: removeGuestMuseHooks
  },
  kiro: {
    status: guestKiroStatus,
    install: installGuestKiroHooks,
    remove: removeGuestKiroHooks
  },
  'jcode-toml': {
    status: guestJcodeStatus,
    install: installGuestJcodeHooks,
    remove: removeGuestJcodeHooks
  },
  dsh: {
    status: guestDshStatus,
    install: installGuestDshHooks,
    remove: removeGuestDshHooks
  },
  hermes: {
    status: guestHermesStatus,
    install: installGuestHermesHooks,
    remove: removeGuestHermesHooks
  },
  'kimi-toml': {
    status: guestKimiStatus,
    install: installGuestKimiHooks,
    remove: removeGuestKimiHooks
  },
  'amp-plugin': {
    status: guestAmpStatus,
    install: installGuestAmpHooks,
    remove: removeGuestAmpHooks
  }
}
