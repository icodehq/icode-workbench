# iCode Workbench

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português (BR)</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <strong>Français</strong>
</p>

<h3 align="center">Tous les agents. Toutes les plateformes. Un seul atelier.</h3>

<p align="center">
  iCode Workbench est l’environnement universel de développement d’agents (ADE) :
  exécutez Claude Code, Codex et OpenCode en parallèle, chacun dans son propre worktree
  Git. Mira surveille tous les dépôts, vous indique ce qui demande votre attention et peut
  agir entre les projets. Relisez les changements là où l’agent a travaillé et gardez le
  terminal actif lorsque l’application redémarre.
</p>

<p align="center">
  <img src=".github/assets/projects-wall.png" alt="Le mur de projets d’iCode Workbench avec les sessions actives, les éléments à traiter et l’activité récente de trois projets WSL" width="960" />
</p>

## Pourquoi iCode Workbench ?

- **Tous les agents, un seul atelier.** Aujourd’hui : Claude Code, Codex et OpenCode ;
  le modèle d’adaptateurs est conçu pour accueillir d’autres harness.
- **Toutes les plateformes.** Linux (WSL2/WSLg), Windows x64 et macOS x64 / arm64.
- **Parallèle par défaut.** Chaque session dispose de sa propre branche et de son worktree Git.
- **Mira entre les projets.** Une conversation pour la file d’attente, les blocages et les
  actions inter-projets.
- **Relire là où l’agent a travaillé.** Diffs de tâches, Source Control et Monaco dans le
  même checkout de session.

## Prise en charge actuelle

- **Agents :** Claude Code, Codex, OpenCode
- **Plateformes :** Linux (WSL2/WSLg), Windows x64, macOS x64 / arm64

## Compiler depuis les sources

```bash
git clone https://github.com/icodehq/icode-workbench.git
cd icode-workbench
corepack enable
pnpm install
pnpm dev
```

## Statut

iCode Workbench est en développement expérimental précoce et évolue rapidement. Les
fonctionnalités, les schémas de stockage et le packaging peuvent changer d’une version à
l’autre. Appliquez les bonnes pratiques Git sur du vrai travail et consultez le
[journal des modifications](CHANGELOG.md) avant de mettre à jour.

> Ceci est une présentation traduite. Le [README anglais](README.md) fait foi.

[English README](README.md) · [Contribuer](.github/CONTRIBUTING.md) ·
[Sécurité](SECURITY.md) · [Journal des modifications](CHANGELOG.md)
