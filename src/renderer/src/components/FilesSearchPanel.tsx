import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type {
  FileSearchPayload,
  FilesReplacePayload,
  GitCheckIgnorePayload
} from '../../../shared/icode-api'
import type { FileSearchMatch } from '../../../shared/domain/workspace-files'
import { isSearchPathIncluded } from '../../../shared/domain/glob'
import { compileTextMatcher } from '../../../shared/domain/text-search'
import { callApi, errorNotice } from '../lib/api'
import { useFilesSettings } from '../files/files-settings'
import { isGitMetadata, parsePatterns, unavailableText } from '../files/search-utils'
import { translate } from '../i18n/i18n-store'
import { useT, useTp } from '../i18n/use-i18n'
import type { Notice } from '../state/workspace'
import { ReplaceFilesDialog } from './FilesDialogs'

type Props = {
  sessionId: string
  /** True while Search is the visible pane; focuses the query when it appears. */
  active: boolean
  notify: (notice: Notice) => void
  /** Opens a match in the Files pane at its line. */
  onOpenPath: (path: string, line: number) => void
  /** Files on disk changed, so the Files tree should reload its open tabs. */
  onReplaced: () => void
}

/**
 * The inspector's Search pane.
 *
 * Termio keeps Search out of the Files tree, and so do we: the tree stays a
 * tree, and this pane owns the query, filters, grouped results and replace
 * flow. Results open in the Files pane instead of covering the search.
 */
export default function FilesSearchPanel({
  sessionId,
  active,
  notify,
  onOpenPath,
  onReplaced
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const settings = useFilesSettings()

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<FileSearchPayload | null>(null)
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchWholeWord, setSearchWholeWord] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
  const [searchInclude, setSearchInclude] = useState('')
  const [searchExclude, setSearchExclude] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchNote, setSearchNote] = useState('')
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [replaceText, setReplaceText] = useState('')
  const [replacePrompt, setReplacePrompt] = useState<{
    matches: number
    files: number
    paths: string[]
  } | null>(null)
  const [replaceBusy, setReplaceBusy] = useState(false)
  const [replaceReport, setReplaceReport] = useState<Array<{ path: string; reason: string }>>([])

  const inputRef = useRef<HTMLInputElement | null>(null)
  const searchSequence = useRef(0)

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  const searchOptions = useMemo(
    () => ({
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      regex: searchRegex,
      include: parsePatterns(searchInclude),
      exclude: parsePatterns(searchExclude),
      limit: 200
    }),
    [searchCaseSensitive, searchExclude, searchInclude, searchRegex, searchWholeWord]
  )

  const clearSearch = (): void => {
    searchSequence.current += 1
    setQuery('')
    setSearching(false)
    setResults(null)
    setSearchError(null)
    setSearchNote('')
  }

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults(null)
      setSearchError(null)
      return
    }
    const matcher = compileTextMatcher(trimmed, searchOptions)
    if (matcher.error !== null) {
      // Keep the previous results visible; the error explains why nothing new
      // is coming without erasing the user's last working scan.
      setSearchError(translate('files.search.invalidRegex'))
      return
    }
    const sequence = ++searchSequence.current
    setSearching(true)
    setSearchError(null)
    setSearchNote('')
    setReplaceReport([])
    const result = await callApi<FileSearchPayload>(
      window.icode.files.search({ sessionId, query: trimmed, ...searchOptions })
    )
    if (searchSequence.current !== sequence) return
    setSearching(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    const value = result.value
    if (value.status === 'unavailable') {
      setResults(value)
      setSearchNote('')
      if (value.reason === 'invalid-query') setSearchError(value.detail)
      else notify({ tone: 'error', message: unavailableText(value) })
      return
    }
    let matches = value.matches.filter(
      (match) =>
        !isGitMetadata(match.path) && isSearchPathIncluded(match.path, [], settings.exclude)
    )
    let note = ''
    if (settings.excludeGitIgnore && matches.length > 0) {
      const check = await callApi<GitCheckIgnorePayload>(
        window.icode.git.checkIgnore({
          sessionId,
          paths: [...new Set(matches.map((match) => match.path))]
        })
      )
      if (searchSequence.current !== sequence) return
      if (check.ok && check.value.status === 'ok') {
        const ignored = new Set(check.value.ignored)
        matches = matches.filter((match) => !ignored.has(match.path))
      } else {
        note = translate('files.notice.ignoreSearchUnavailable')
      }
    }
    if (searchSequence.current !== sequence) return
    setResults({ ...value, matches })
    setSearchNote(note)
  }

  /** Stops the in-flight scan; the backend cancels the current search. */
  const stopSearch = async (): Promise<void> => {
    searchSequence.current += 1
    setSearching(false)
    setResults(null)
    setSearchNote(translate('files.notice.searchCancelled'))
    await callApi<{ cancelled: boolean }>(window.icode.files.cancelSearch({ sessionId }))
  }

  const requestReplace = (): void => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    if (searchRegex) {
      setSearchError(translate('files.notice.regexReplaceUnsupported'))
      return
    }
    if (results === null || results.status !== 'ok' || results.matches.length === 0) {
      setSearchNote(translate('files.notice.runSearchFirst'))
      return
    }
    const matcher = compileTextMatcher(trimmed, searchOptions)
    if (matcher.error !== null) {
      setSearchError(translate('files.search.invalidRegex'))
      return
    }
    setSearchError(null)
    const paths = [...new Set(results.matches.map((match) => match.path))]
    setReplacePrompt({ matches: results.matches.length, files: paths.length, paths })
  }

  const confirmReplace = async (): Promise<void> => {
    if (replacePrompt === null) return
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    const paths =
      results !== null && results.status === 'ok'
        ? [...new Set(results.matches.map((match) => match.path))]
        : []
    setReplaceBusy(true)
    const result = await callApi<FilesReplacePayload>(
      window.icode.files.replace({
        sessionId,
        query: trimmed,
        replacement: replaceText,
        caseSensitive: searchCaseSensitive,
        wholeWord: searchWholeWord,
        regex: false,
        include: searchOptions.include,
        exclude: searchOptions.exclude,
        paths
      })
    )
    setReplaceBusy(false)
    setReplacePrompt(null)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    const value = result.value
    if (value.status === 'unavailable') {
      if (value.reason === 'invalid-query') setSearchError(value.detail)
      else notify({ tone: 'error', message: unavailableText(value) })
      return
    }
    const skipped = value.results.filter((entry) => !entry.ok).length
    notify({
      tone: skipped > 0 ? 'info' : 'success',
      message:
        tp('files.notice.replaced', value.replacements, {
          files: tp('files.summary.files', value.files)
        }) +
        (skipped > 0 ? ` · ${t('files.notice.skipped', { count: skipped })}` : '') +
        (value.truncated ? ` · ${t('files.notice.truncated')}` : '')
    })
    // Clean editor tabs follow the new disk text in the Files pane; dirty
    // tabs keep the user's buffer and surface the change through its conflict
    // dialog.
    onReplaced()
    await runSearch()
    setReplaceReport(
      value.results
        .filter((entry) => !entry.ok)
        .map((entry) => ({
          path: entry.path,
          reason: entry.reason ?? entry.detail ?? 'skipped'
        }))
    )
  }

  const grouped = useMemo((): Array<{ path: string; matches: FileSearchMatch[] }> => {
    if (results === null || results.status !== 'ok') return []
    const groups = new Map<string, FileSearchMatch[]>()
    for (const match of results.matches) {
      const list = groups.get(match.path)
      if (list === undefined) groups.set(match.path, [match])
      else list.push(match)
    }
    return [...groups.entries()]
      .map(([path, matches]) => ({
        path,
        matches: matches.sort((a, b) => a.line - b.line)
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }, [results])

  const toggleGroup = (path: string): void => {
    setCollapsedFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const hasQuery = query.trim().length > 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="files-search-panel">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Search size={11} className="shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          placeholder={t('files.toolbar.search')}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="files-search-input"
          onChange={(event) => {
            setQuery(event.target.value)
            setSearchError(null)
            setSearchNote('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch()
            if (event.key === 'Escape') clearSearch()
          }}
        />
        {query.length > 0 ? (
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={clearSearch}
            data-testid="files-search-clear"
            title={t('files.toolbar.clearSearch')}
          >
            <X size={11} />
          </button>
        ) : null}
      </div>

      <div className="border-b border-border px-1.5 py-1" data-testid="files-search-options">
        <div className="flex flex-wrap items-center gap-0.5">
          {(
            [
              ['files-search-case', 'Aa', t('files.toolbar.matchCase'), searchCaseSensitive, setSearchCaseSensitive],
              ['files-search-whole-word', 'W', t('files.toolbar.matchWholeWord'), searchWholeWord, setSearchWholeWord],
              ['files-search-regex', '.*', t('files.toolbar.useRegex'), searchRegex, setSearchRegex]
            ] as const
          ).map(([testId, label, title, value, setter]) => (
            <button
              key={testId}
              type="button"
              aria-pressed={value}
              title={title}
              className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 font-mono text-[10px] ${
                value
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              data-testid={testId}
              onClick={() => setter(!value)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={searchFiltersOpen}
            aria-expanded={searchFiltersOpen}
            title={t('files.toolbar.filtersTitle')}
            className={`ml-1 inline-flex h-6 items-center rounded px-1.5 text-[10px] ${
              searchFiltersOpen
                ? 'bg-accent/15 text-accent'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            data-testid="files-search-filters"
            onClick={() => setSearchFiltersOpen((open) => !open)}
          >
            {t('files.toolbar.filters')}
          </button>
          <span className="ml-auto flex items-center gap-1">
            {searching ? (
              <button
                type="button"
                className="inline-flex h-6 items-center rounded border border-border px-1.5 text-[10px] text-signal hover:bg-muted"
                data-testid="files-search-stop"
                onClick={() => void stopSearch()}
              >
                {t('files.toolbar.stop')}
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex h-6 items-center rounded border border-border px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              title={
                searchRegex
                  ? t('files.toolbar.regexReplaceTitle')
                  : t('files.toolbar.replaceAllTitle')
              }
              disabled={
                searchRegex ||
                searching ||
                results === null ||
                results.status !== 'ok' ||
                results.matches.length === 0
              }
              data-testid="files-replace-run"
              onClick={requestReplace}
            >
              {t('files.toolbar.replaceAll')}
            </button>
          </span>
        </div>
        {searchFiltersOpen ? (
          <div className="mt-1 grid gap-1">
            <input
              value={searchInclude}
              placeholder={t('files.toolbar.include')}
              className="h-6 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
              data-testid="files-search-include"
              onChange={(event) => setSearchInclude(event.target.value)}
            />
            <input
              value={searchExclude}
              placeholder={t('files.toolbar.exclude')}
              className="h-6 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
              data-testid="files-search-exclude"
              onChange={(event) => setSearchExclude(event.target.value)}
            />
          </div>
        ) : null}
        <label className="mt-1 flex items-center gap-1">
          <span className="shrink-0 text-[9.5px] text-muted-foreground">
            {t('files.toolbar.replaceLabel')}
          </span>
          <input
            value={replaceText}
            placeholder={t('files.toolbar.replacement')}
            className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="files-replace-input"
            onChange={(event) => setReplaceText(event.target.value)}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1" data-testid="files-search-results">
        <p className="px-1 py-1 text-[10px] text-muted-foreground" data-testid="files-search-summary">
          {searching
            ? t('files.search.searching')
            : results === null
              ? t('files.search.pressEnter')
              : results.status === 'unavailable'
                ? t('files.search.unavailable')
                : `${t('files.search.summary', {
                    matches: results.matches.length,
                    files: grouped.length,
                    scanned: results.scannedFiles
                  })}${results.truncated ? t('files.search.truncated') : ''}${
                    results.cancelled ? t('files.search.stopped') : ''
                  }`}
        </p>
        {searchError !== null ? (
          <p className="px-1 py-1 text-[10px] text-destructive" data-testid="files-search-error">
            {searchError}
          </p>
        ) : null}
        {searchNote.length > 0 ? (
          <p className="px-1 py-1 text-[10px] text-signal" data-testid="files-search-note">
            {searchNote}
          </p>
        ) : null}
        {replaceReport.length > 0 ? (
          <ul
            className="mx-1 mb-1 rounded border border-signal/40 bg-signal-weak px-2 py-1 text-[9.5px] text-signal"
            data-testid="files-replace-report"
          >
            {replaceReport.map((entry) => (
              <li key={`${entry.path}:${entry.reason}`} className="truncate" title={entry.path}>
                {entry.path}: {entry.reason}
              </li>
            ))}
          </ul>
        ) : null}
        {hasQuery
          ? grouped.map((group) => {
              const collapsed = collapsedFiles.has(group.path)
              return (
                <div key={group.path} data-testid={`files-search-group-${group.path}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/60"
                    aria-expanded={!collapsed}
                    data-testid={`files-search-file-${group.path}`}
                    onClick={() => toggleGroup(group.path)}
                  >
                    <span className="w-3 shrink-0 text-[9px] text-muted-foreground">
                      {collapsed ? '▸' : '▾'}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                      {group.path}
                    </span>
                    <span className="shrink-0 text-[9px] text-muted-foreground">
                      {group.matches.length}
                    </span>
                  </button>
                  {collapsed
                    ? null
                    : group.matches.map((match, index) => (
                        <button
                          key={`${match.path}:${String(match.line)}:${String(index)}`}
                          type="button"
                          className="block w-full rounded px-1 py-0.5 pl-5 text-left hover:bg-muted/60"
                          onClick={() => onOpenPath(match.path, match.line)}
                          data-testid={`files-search-hit-${match.path}-${String(match.line)}`}
                        >
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {match.line}: {match.text}
                          </span>
                        </button>
                      ))}
                </div>
              )
            })
          : null}
        {results !== null && results.status === 'unavailable' ? (
          <p className="px-1 py-1 text-[10px] text-signal">{unavailableText(results)}</p>
        ) : null}
      </div>

      {replacePrompt !== null ? (
        <ReplaceFilesDialog
          matches={replacePrompt.matches}
          files={replacePrompt.files}
          paths={replacePrompt.paths}
          busy={replaceBusy}
          onConfirm={() => void confirmReplace()}
          onCancel={() => setReplacePrompt(null)}
        />
      ) : null}
    </div>
  )
}
