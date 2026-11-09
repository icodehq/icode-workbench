# iCode Workbench i18n

English (`en`) is the source language and the runtime fallback. The app also
ships Simplified Chinese, Japanese, Korean, Spanish, Brazilian Portuguese,
German and French chrome.

## Translation status

All non-English catalogs are **AI-assisted translations** and **have not been
reviewed by native speakers**. They are marked for native review; corrections
belong in the locale catalog, never in the English source. English remains
authoritative when a translation is ambiguous.

The catalogs are bundled, dependency-free TypeScript, shared by main, preload
and renderer. Nothing is fetched at runtime; CSP never has to allow a
translation host.

## Scope

Localized:

- renderer chrome: rail, top bar, status bar, settings, projects, sessions,
  tasks, schedules, assistant, Files, Source Control, dialogs, empty states,
  tooltips, placeholders and aria-labels;
- native menus, window-close fallback dialog and folder pickers;
- OS notifications authored by iCode;
- user-facing application errors.

Not localized:

- terminal and harness output, tool output, Git output and model output;
- project names, session titles, branch names, paths, prompts and user content;
- product and harness names (`iCode`, `Claude Code`, `Codex`, `OpenCode`,
  `Supervisor`, `Mira` unless the surrounding sentence needs a translated
  role);
- installer UI (follow-up work outside the app bundle).

## Persisted text

Text written to the database before 0.7 stays as written. New task, schedule
and assistant messages are localized at write time with the palette active
then; changing the language does not rewrite history. `AppError` rows carry an
English `message` plus an optional `messageKey`; older rows without a key keep
their English message.

## Adding or changing a message

1. Add the key to `catalogs/en.ts` first.
2. Add every other locale; `pnpm test` checks exact key parity, placeholder
   parity, empty messages and plural variants.
3. Use `t(locale, key, params)` in shared/main code and `useT()` in components.
4. Keep placeholders in braces (`{name}`) and keep product names unchanged.
5. Never concatenate translated fragments; pass values as placeholders so each
   locale controls word order.
