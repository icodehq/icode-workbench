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
  Yarcy はすべてのリポジトリを横断して監視し、あなたの対応が必要なことを伝え、プロジェクト
  をまたいで行動できます。エージェントが作業した場所で変更をレビューし、アプリを再起動
  してもターミナルを維持します。
</p>

<p align="center">
  <img src=".github/assets/workbench-0916-shell.png" alt="iCode Workbench のワークベンチ。プロジェクトとタスクのサイドバー、アプリとセッションのタブ、ライブターミナル、Source Control の diff を表示" width="960" />
</p>

## iCode Workbench を選ぶ理由

- **すべてのエージェントを 1 つのワークベンチで。** 現在は Claude Code、Codex、
  OpenCode に対応。アダプターモデルにより、さらに多くの harness を追加できます。
- **すべてのプラットフォーム。** Linux（WSL2/WSLg）、Windows x64、macOS x64 / arm64。
- **デフォルトで並列。** すべてのセッションが独自のブランチと Git ワークツリーを持ちます。
- **セッション行がそのまま操作面になります。** セッションを開かずに右クリックで詳細、
  スリープ／復帰、再起動、ピン留め、削除を実行できます。削除時にブランチ名の入力を
  求めず、失われる変更を明示し、ブランチは常に保持します。
- **プロジェクトをまたぐ Yarcy（既定名、いつでも変更可能）。** キュー、ブロッカー、横断的なアクションを 1 つの会話で。
- **エージェントが作業した場所でレビュー。** タスクの diff、ファイル、検索、Source
  Control が同じセッションチェックアウトにあります。
- **1 つのサイドバーですべてを把握。** プロジェクト、ダイレクトセッション、ピン、横断タスクキューが常に表示され、Yarcy・設定・スケジュールはタブで開きます。

<p align="center">
  <a href=".github/assets/workbench-0916-session-menu.png"><img src=".github/assets/workbench-0916-session-menu.png" alt="セッション行のコンテキストメニュー。セッションの詳細、セッションをスリープ、セッションを再起動、先頭にピン留め、セッションを削除" width="100%" /></a>
</p>

*セッションを開いていなくても、その行からライフサイクル全体を操作できます。*

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
