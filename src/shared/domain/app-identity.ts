/**
 * One canonical product identity.
 *
 * The JSON file is shared with the CommonJS electron-builder config so the
 * installer, runtime paths, guest paths and branch names cannot drift apart.
 */

import identity from '../app-identity.json'

export type AppIdentity = {
  name: string
  packageName: string
  appId: string
  executableName: string
  envPrefix: string
  localProfileDirName: string
  guestDirName: string
  dbFileName: string
  branchPrefix: string
}

export const APP_IDENTITY = identity satisfies AppIdentity
export const APP_NAME = identity.name
export const APP_PACKAGE_NAME = identity.packageName
export const APP_ID = identity.appId
export const APP_EXECUTABLE_NAME = identity.executableName
export const APP_ENV_PREFIX = identity.envPrefix
export const APP_LOCAL_PROFILE_DIR_NAME = identity.localProfileDirName
export const APP_GUEST_DIR_NAME = identity.guestDirName
export const APP_DB_FILE_NAME = identity.dbFileName
export const APP_BRANCH_PREFIX = identity.branchPrefix
