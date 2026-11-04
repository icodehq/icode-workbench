# Bundled UI fonts

- `ibm-plex-sans-latin.woff2` — IBM Plex Sans, variable, Latin subset.
  Source: Google Fonts (IBM Plex Sans v23). SIL Open Font License 1.1.
- `jetbrains-mono-latin.woff2` — JetBrains Mono, variable, Latin subset.
  Source: Google Fonts (JetBrains Mono v24). SIL Open Font License 1.1.

They are bundled so the renderer's `default-src 'self'` CSP never needs a
third-party font host. Chinese/CJK text falls back to the platform UI font.
