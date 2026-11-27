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
  iCode Workbench est l’environnement de développement pour les flottes d’agents : 44
  agents CLI exécutables travaillent en parallèle, chacun dans son propre worktree Git.
  Les bots voient les projets, les tâches, les sessions et les décisions de revue, et vous
  indiquent ce qui demande votre attention. Relisez les changements dans le checkout où
  l’agent a travaillé et gardez le terminal actif lorsque l’application redémarre.
</p>

<p align="center">
  <strong>Pas de télémétrie. Pas de compte. Pas d’analyse.</strong><br/>
  iCode n’appelle pas d’API de modèle depuis l’application ; le trafic de modèle appartient
  à votre harness. Aucun compte à hacher, aucune donnée à envoyer.
  <a href="PRIVACY.md">Vérifier →</a>
</p>

<p align="center">
  <img src=".github/assets/workbench-1127-shell.png" alt="Le workbench iCode avec Bots, projets et worktrees dans la barre latérale, un terminal en direct, un onglet de diff ouvert et l’inspecteur Source Control avec les changements du worktree" width="960" />
</p>

## Pourquoi iCode Workbench ?

- **44 agents CLI exécutables.** 21 avec des hooks de statut gérés, et Claude Code, Codex
  et OpenCode avec injection native de fournisseur. Chaque agent peut tourner en parallèle
  dans son propre worktree Git.
- **Toutes les plateformes.** Linux (WSL2/WSLg), Windows x64 et macOS x64 / arm64.
- **Isolation par défaut.** Chaque session directe lancée depuis un nouvel espace de
  travail isolé dispose de sa propre branche et de son worktree. Le dossier du projet est
  le checkout principal du dépôt ; seules les sessions qui le choisissent explicitement
  le partagent, avec un avertissement permanent.
- **Un worktree est un espace de travail.** Les onglets de la barre de titre réunissent
  terminaux, fichiers et diffs ; les divisions s’imbriquent et l’inspecteur permanent
  propose Files, Search et Source Control.
- **Des bots entre les projets (25 modèles officiels, dont Yarcy).** Chaque bot a son Home
  Chat et peut rejoindre des salles de groupe avec fils, modes de réponse et relais par
  @mention. Ils créent, annulent, relancent et archivent des tâches, mais ne peuvent pas
  approuver une revue, fusionner ni pousser.
- **Relire là où l’agent a travaillé.** Accepter une revue enregistre le jugement et ne
  commit, fusionne, pousse ou supprime jamais rien. **Accept & merge…** accepte d’abord,
  puis ouvre le sélecteur de fusion pour confirmer la fusion comme un acte séparé.
- **Une barre latérale, deux surfaces.** Bots, projets et sessions épinglés et l’arbre
  Projects partagent une barre latérale ; la cloche needs-you est la file inter-projets.
  Un projet ouvre son espace Sessions ou l’atelier de tâches ; Bots, Réglages et
  Planifications s’ouvrent en onglets auxiliaires.
- **Des terminaux qui survivent à l’application.** Un host indépendant possède les PTY ;
  fermer la fenêtre ou quitter iCode n’arrête pas les agents.
- **Local-first.** L’état vit dans SQLite sur votre machine ; pas de télémétrie, pas de
  service hébergé et pas d’appels de modèle depuis l’application.

<p align="center">
  <a href=".github/assets/workbench-1127-bots.png"><img src=".github/assets/workbench-1127-bots.png" alt="La salle de groupe Atlas crew avec une question du propriétaire, la réponse de Yarcy, le panneau Items à droite et le compositeur du groupe" width="100%" /></a>
</p>

*Une salle de groupe : mentionnez un bot, recevez une réponse en streaming et gardez le
travail en attente dans le panneau Items.*

<p align="center">
  <a href=".github/assets/workbench-1127-session-menu.png"><img src=".github/assets/workbench-1127-session-menu.png" alt="Menu contextuel d’une ligne de session avec Détails de la session, Mettre la session en veille, Redémarrer la session, Épingler en haut et Supprimer la session" width="100%" /></a>
</p>

*Chaque ligne de session porte tout son cycle de vie, même lorsqu’elle n’est pas ouverte.*

## Prise en charge actuelle

- **Agents exécutables :** 44 agents CLI (dont Claude Code, Codex et OpenCode).
- **Injection native de fournisseur + conversation de bots :** Claude Code, Codex et
  OpenCode.
- **Hooks de statut gérés :** 21 harnesses qui affichent travail, attente et fin dans la
  barre latérale.
- **Plateformes :** Linux (WSL2/WSLg), Windows x64, macOS x64 / arm64.

## Compiler depuis les sources

**Prérequis :** Node 24.x (`.nvmrc` épingle 24.15.0), Corepack avec pnpm 11.16.0, Git et
au moins un harness dans le `PATH`. Linux a aussi besoin de `build-essential` et
`python3` ; macOS a besoin des Xcode Command Line Tools.

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
[Sécurité](SECURITY.md) · [Traductions](TRANSLATIONS.md) · [Journal des modifications](CHANGELOG.md)
