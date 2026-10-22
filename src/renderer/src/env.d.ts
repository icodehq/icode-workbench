import type { AdeApi } from '../../shared/ade-api'

declare global {
  interface Window {
    ade: AdeApi
  }
}

export {}
