# iCode Workbench

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <strong>日本語</strong> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português (BR)</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a>
</p>

<h3 align="center">すべてのエージェント。すべてのプラットフォーム。ひとつのワークベンチ。</h3>

<p align="center">
  iCode Workbench はユニバーサルなエージェント開発環境（ADE）です。Claude Code、
  Codex、OpenCode を並列で実行し、各セッションに独立した Git ワークツリーを用意します。
  Mira はすべてのリポジトリを横断して監視し、あなたの対応が必要なことを伝え、プロジェクト
  をまたいで行動できます。エージェントが作業した場所で変更をレビューし、アプリを再起動
  してもターミナルを維持します。
</p>

<p align="center">
  <img src=".github/assets/projects-wall.png" alt="iCode Workbench のプロジェクト一覧。3 つの WSL プロジェクトの実行中セッション、対応が必要な項目、最終アクティビティを表示" width="960" />
</p>

## iCode Workbench を選ぶ理由

- **すべてのエージェントを 1 つのワークベンチで。** 現在は Claude Code、Codex、
  OpenCode に対応。アダプターモデルにより、さらに多くの harness を追加できます。
- **すべてのプラットフォーム。** Linux（WSL2/WSLg）、Windows x64、macOS x64 / arm64。
- **デフォルトで並列。** すべてのセッションが独自のブランチと Git ワークツリーを持ちます。
- **プロジェクトをまたぐ Mira。** キュー、ブロッカー、横断的なアクションを 1 つの会話で。
- **エージェントが作業した場所でレビュー。** タスクの diff、Source Control、Monaco が
  同じセッションチェックアウトにあります。

## 現在の対応

- **エージェント：** Claude Code、Codex、OpenCode
- **プラットフォーム：** Linux（WSL2/WSLg）、Windows x64、macOS x64 / arm64

## ソースからビルド

```bash
git clone https://github.com/icodehq/icode-workbench.git
cd icode-workbench
corepack enable
pnpm install
pnpm dev
```

## ステータス

iCode Workbench は初期実験段階にあり、急速に改善しています。機能、ストレージ
スキーマ、パッケージングはリリース間で変更される可能性があります。実際の作業では
通常の Git 運用を守り、アップグレード前に [変更履歴](CHANGELOG.md) を確認してください。

> これは翻訳された概要です。正式な情報は [English README](README.md) を参照してください。

[English README](README.md) · [コントリビューション](.github/CONTRIBUTING.md) ·
[セキュリティ](SECURITY.md) · [変更履歴](CHANGELOG.md)
