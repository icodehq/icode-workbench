# iCode Workbench

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português (BR)</a> ·
  <strong>Deutsch</strong> ·
  <a href="README.fr.md">Français</a>
</p>

<h3 align="center">Jeder Agent. Jede Plattform. Eine Werkbank.</h3>

<p align="center">
  iCode Workbench ist die Entwicklungsumgebung für Agentenflotten: 44 startbare CLI-Agenten
  arbeiten parallel, jeder in einem eigenen Git-Worktree. Bots sehen Projekte, Aufgaben,
  Sitzungen und Review-Entscheidungen und sagen dir, was deine Aufmerksamkeit braucht.
  Prüfe Änderungen in dem Checkout, in dem der Agent gearbeitet hat, und behalte das
  Terminal, wenn die App neu startet.
</p>

<p align="center">
  <strong>Keine Telemetrie. Kein Konto. Keine Analyse.</strong><br/>
  iCode ruft keine Modell-APIs aus der App auf; Modellverkehr gehört zu deinem Harness.
  Es gibt kein Konto zum Hashen und keine Daten zum Senden.
  <a href="PRIVACY.md">Selbst prüfen →</a>
</p>

<p align="center">
  <img src=".github/assets/workbench-1127-shell.png" alt="Die iCode-Workbench mit Bots, Projekten und Worktrees in der Seitenleiste, einem Live-Terminal, einem offenen Diff-Tab und dem Source-Control-Inspektor mit den Änderungen des Worktrees" width="960" />
</p>

## Warum iCode Workbench?

- **44 startbare CLI-Agenten.** 21 mit verwalteten Status-Hooks, und Claude Code, Codex
  und OpenCode mit nativer Provider-Injektion. Jeder Agent kann parallel in seinem eigenen
  Git-Worktree laufen.
- **Jede Plattform.** Linux (WSL2/WSLg), Windows x64 und macOS x64 / arm64.
- **Standardmäßig isoliert.** Jede direkte Sitzung aus einem neuen isolierten
  Arbeitsbereich erhält ihren eigenen Branch und Worktree. Der Projektordner ist der
  Haupt-Checkout des Repositories; nur ausdrücklich gewählte Sitzungen teilen ihn, mit
  einem dauerhaften Warnhinweis.
- **Ein Worktree ist ein Arbeitsbereich.** Die Tabs in der Titelleiste bündeln Terminals,
  Dateien und Diffs; Splits lassen sich verschachteln, und der dauerhafte Inspektor bietet
  Files, Search und Source Control.
- **Bots über Projekte hinweg (25 offizielle Vorlagen, inklusive Yarcy).** Jeder Bot hat
  seinen eigenen Home-Chat und kann Gruppenräume mit Threads, Antwortmodi und
  @mention-Übergaben betreten. Sie erstellen, stornieren, wiederholen und archivieren
  Aufgaben, können aber keinen Review genehmigen, mergen oder pushen.
- **Prüfen, wo der Agent gearbeitet hat.** Ein Review anzunehmen protokolliert das Urteil
  und committet, mergt, pusht oder löscht nie etwas. **Accept & merge…** nimmt zuerst an
  und öffnet dann die Merge-Auswahl, in der der Merge als eigener Schritt bestätigt wird.
- **Eine Seitenleiste, zwei Arbeitsflächen.** Bots, angeheftete Projekte und Sitzungen
  sowie der Projects-Baum teilen sich eine Seitenleiste; die Needs-you-Glocke ist die
  projektübergreifende Warteschlange. Ein Projekt öffnet seinen Sessions-Arbeitsbereich
  oder die Aufgaben-Workbench; Bots, Einstellungen und Zeitpläne öffnen als Hilfs-Tabs.
- **Terminals überleben die App.** Ein eigenständiger Host besitzt die PTYs; das Schließen
  des Fensters oder Beenden von iCode stoppt die Agenten nicht.
- **Local-first.** Der Zustand liegt in SQLite auf deinem Rechner; keine Telemetrie, kein
  gehosteter Dienst und keine Modellaufrufe aus der App.

<p align="center">
  <a href=".github/assets/workbench-1127-bots.png"><img src=".github/assets/workbench-1127-bots.png" alt="Der Gruppenraum Atlas crew mit einer Frage des Eigentümers, Yarcys Antwort, der Items-Leiste rechts und dem Gruppen-Composer" width="100%" /></a>
</p>

*Ein Gruppenraum: Erwähne einen Bot, erhalte eine Streaming-Antwort und behalte die
offene Arbeit in der Items-Leiste.*

<p align="center">
  <a href=".github/assets/workbench-1127-session-menu.png"><img src=".github/assets/workbench-1127-session-menu.png" alt="Kontextmenü einer Sitzungszeile mit Sitzungsdetails, Sitzung in Ruhezustand versetzen, Sitzung neu starten, Oben anheften und Sitzung entfernen" width="100%" /></a>
</p>

*Jede Sitzungszeile trägt ihren vollständigen Lebenszyklus — auch für eine Sitzung,
die gerade nicht geöffnet ist.*

## Aktuell unterstützt

- **Startbare Agenten:** 44 CLI-Agenten (darunter Claude Code, Codex und OpenCode).
- **Native Provider-Injektion + Bot-Unterhaltung:** Claude Code, Codex und OpenCode.
- **Verwaltete Status-Hooks:** 21 Harnesses, die Arbeit, Warten und Abschluss in der
  Seitenleiste anzeigen.
- **Plattformen:** Linux (WSL2/WSLg), Windows x64, macOS x64 / arm64.

## Aus dem Quellcode bauen

**Voraussetzungen:** Node 24.x (`.nvmrc` pinnt 24.15.0), Corepack mit pnpm 11.16.0, Git
und mindestens ein Harness im `PATH`. Linux braucht zusätzlich `build-essential` und
`python3`; macOS braucht die Xcode Command Line Tools.

```bash
git clone https://github.com/icodehq/icode-workbench.git
cd icode-workbench
corepack enable
pnpm install
pnpm dev
```

## Status

iCode Workbench befindet sich in einer frühen experimentellen Phase und wird schnell
weiterentwickelt. Funktionen, Speicherschemata und Paketierung können sich zwischen
Versionen ändern. Arbeite mit üblicher Git-Hygiene und lies vor einem Upgrade das
[Changelog](CHANGELOG.md).

> Dies ist eine übersetzte Übersicht. Das [englische README](README.md) ist die
> maßgebliche Quelle.

[English README](README.md) · [Mitwirken](.github/CONTRIBUTING.md) ·
[Sicherheit](SECURITY.md) · [Übersetzungen](TRANSLATIONS.md) · [Changelog](CHANGELOG.md)
