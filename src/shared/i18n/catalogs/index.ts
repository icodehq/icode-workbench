import type { Locale } from '../locales'
import { en, type MessageCatalog, type MessageKey } from './en'
import { zhCN } from './zh-CN'
import { ja } from './ja'
import { ko } from './ko'
import { es } from './es'
import { ptBR } from './pt-BR'
import { de } from './de'
import { fr } from './fr'

export const CATALOGS: Record<Locale, MessageCatalog> = {
  en,
  'zh-CN': zhCN,
  ja,
  ko,
  es,
  'pt-BR': ptBR,
  de,
  fr
}

export { en }
export type { MessageCatalog, MessageKey }
