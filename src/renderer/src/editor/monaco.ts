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

export function monacoThemeForDocument(): 'vs' | 'vs-dark' {
  const theme = document.documentElement.dataset.theme
  if (theme === 'light') return 'vs'
  if (theme === 'dark') return 'vs-dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs'
}

let configured = false

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
    configured = true
  }
  return monacoRuntime as unknown as MonacoApi
}
