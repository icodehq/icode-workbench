# iCode Workbench

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <strong>Português (BR)</strong> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a>
</p>

<h3 align="center">Todos os agentes. Todas as plataformas. Uma única bancada.</h3>

<p align="center">
  O iCode Workbench é o ambiente universal de desenvolvimento de agentes (ADE): execute
  Claude Code, Codex e OpenCode em paralelo, cada um em seu próprio worktree do Git. Mira
  acompanha todos os repositórios, informa o que precisa de você e pode agir entre projetos.
  Revise as mudanças onde o agente trabalhou e mantenha o terminal vivo quando o aplicativo
  reiniciar.
</p>

<p align="center">
  <img src=".github/assets/projects-wall.png" alt="O mural de projetos do iCode Workbench com sessões ativas, itens que precisam de atenção e atividade recente em três projetos WSL" width="960" />
</p>

## Por que iCode Workbench?

- **Todos os agentes, uma bancada.** Hoje: Claude Code, Codex e OpenCode; o modelo de
  adaptadores foi feito para adicionar mais harnesses.
- **Todas as plataformas.** Linux (WSL2/WSLg), Windows x64 e macOS x64 / arm64.
- **Paralelo por padrão.** Cada sessão recebe sua própria branch e worktree do Git.
- **Mira entre projetos.** Uma conversa para a fila, os bloqueios e as ações entre projetos.
- **Revisão onde o agente trabalhou.** Diffs de tarefas, Source Control e Monaco no mesmo
  checkout da sessão.

## Suporte atual

- **Agentes:** Claude Code, Codex, OpenCode
- **Plataformas:** Linux (WSL2/WSLg), Windows x64, macOS x64 / arm64

## Compilar a partir do código-fonte

```bash
git clone https://github.com/icodehq/icode-workbench.git
cd icode-workbench
corepack enable
pnpm install
pnpm dev
```

## Status

O iCode Workbench está em desenvolvimento experimental inicial e iterando rapidamente.
Recursos, esquemas de armazenamento e empacotamento podem mudar entre versões. Use boas
práticas de Git em trabalho real e consulte o [changelog](CHANGELOG.md) antes de atualizar.

> Esta é uma visão geral traduzida. O [README em inglês](README.md) é a fonte autoritativa.

[English README](README.md) · [Contribuir](.github/CONTRIBUTING.md) ·
[Segurança](SECURITY.md) · [Changelog](CHANGELOG.md)
