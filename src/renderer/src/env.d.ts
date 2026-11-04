import type { IcodeApi } from '../../shared/icode-api'

declare global {
  interface Window {
    icode: IcodeApi
  }
}

export {}
