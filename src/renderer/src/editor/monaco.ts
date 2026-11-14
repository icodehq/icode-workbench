import * as monacoRuntime from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline'
import type * as monacoTypes from 'monaco-editor'

/** The public root types match the standalone editor API used at runtime. */
export type MonacoApi = typeof monacoTypes

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  scala: 'scala',
  clj: 'clojure',
  cljs: 'clojure',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  bat: 'bat',
  cmd: 'bat'
}

export function languageForPath(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return EXTENSION_LANGUAGE[extension] ?? 'plaintext'
}

export type MonacoThemeName = 'icode-dark' | 'icode-light'

export function monacoThemeForDocument(): MonacoThemeName {
  const theme = document.documentElement.dataset.theme
  if (theme === 'light') return 'icode-light'
  if (theme === 'dark') return 'icode-dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'icode-dark'
    : 'icode-light'
}

let configured = false

function defineWorkbenchThemes(api: MonacoApi): void {
  api.editor.defineTheme('icode-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '94949B' },
      { token: 'keyword', foreground: '7D8CFF' },
      { token: 'string', foreground: '98C379' },
      { token: 'number', foreground: 'D29922' },
      { token: 'type', foreground: '56B6C2' }
    ],
    colors: {
      'editor.background': '#212121',
      'editor.foreground': '#E6E6E8',
      'editorLineNumber.foreground': '#6F6F76',
      'editorLineNumber.activeForeground': '#A0A0A6',
      'editorCursor.foreground': '#7D8CFF',
      'editor.selectionBackground': '#34363F',
      'editor.inactiveSelectionBackground': '#2F2F31',
      'editor.lineHighlightBackground': '#2A2A2C',
      'editorIndentGuide.background1': '#3A3A3D',
      'editorIndentGuide.activeBackground1': '#4A4A4E',
      'editorWidget.background': '#2A2A2C',
      'editorWidget.border': '#4A4A4E',
      'editorSuggestWidget.background': '#2A2A2C',
      'editorSuggestWidget.selectedBackground': '#34363F'
    }
  })
  api.editor.defineTheme('icode-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '696C77' },
      { token: 'keyword', foreground: '2F62D8' },
      { token: 'string', foreground: '50A14F' },
      { token: 'number', foreground: '986801' },
      { token: 'type', foreground: '1B7C83' }
    ],
    colors: {
      'editor.background': '#FAFAFA',
      'editor.foreground': '#383A42',
      'editorLineNumber.foreground': '#9A9CA3',
      'editorLineNumber.activeForeground': '#383A42',
      'editorCursor.foreground': '#2F62D8',
      'editor.selectionBackground': '#E4E6EB',
      'editor.inactiveSelectionBackground': '#EDEDEE',
      'editor.lineHighlightBackground': '#F0F0F1',
      'editorIndentGuide.background1': '#D6D6D9',
      'editorIndentGuide.activeBackground1': '#BDBDC1',
      'editorWidget.background': '#F0F0F1',
      'editorWidget.border': '#BDBDC1',
      'editorSuggestWidget.background': '#F0F0F1',
      'editorSuggestWidget.selectedBackground': '#E4E6EB'
    }
  })
}

/**
 * Loads Monaco's standalone editor API and its basic language grammars.
 *
 * The editor worker is inlined so a packaged `file://` renderer never depends
 * on a separate worker file or a CDN. Language services that need their own
 * workers (TypeScript, JSON, CSS) are deliberately not registered in this
 * slice; basic syntax highlighting is main-thread Monarch.
 */
export function getMonaco(): MonacoApi {
  if (!configured) {
    ;(globalThis as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new EditorWorker()
    }
    defineWorkbenchThemes(monacoRuntime as unknown as MonacoApi)
    configured = true
  }
  return monacoRuntime as unknown as MonacoApi
}
