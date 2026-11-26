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
  Claude Code, Codex e OpenCode em paralelo, cada um em seu próprio worktree do Git. Yarcy
  acompanha todos os repositórios, informa o que precisa de você e pode agir entre projetos.
  Revise as mudanças onde o agente trabalhou e mantenha o terminal vivo quando o aplicativo
  reiniciar.
</p>

<p align="center">
  <img src=".github/assets/workbench-0916-shell.png" alt="O workbench do iCode com a barra lateral de projetos e tarefas, abas de aplicativo e sessão, terminal ao vivo e um diff de Source Control no inspetor" width="960" />
</p>

## Por que iCode Workbench?

- **Todos os agentes, uma bancada.** Hoje: Claude Code, Codex e OpenCode; o modelo de
  adaptadores foi feito para adicionar mais harnesses.
- **Todas as plataformas.** Linux (WSL2/WSLg), Windows x64 e macOS x64 / arm64.
- **Paralelo por padrão.** Cada sessão recebe sua própria branch e worktree do Git.
- **Cada linha de sessão é um painel de controle.** Clique com o botão direito em uma
  sessão para ver detalhes, colocar em repouso ou despertar, reiniciar, fixar e remover
  sem abri-la. A remoção não pede o nome da branch, nomeia as alterações em risco e
  mantém a branch.
- **Yarcy entre projetos (nome padrão, pode ser renomeado).** Uma conversa para a fila, os bloqueios e as ações entre projetos.
- **Revisão onde o agente trabalhou.** Diffs de tarefas, arquivos, busca e Source Control
  no mesmo checkout da sessão.
- **Todo o trabalho em uma barra lateral.** Projetos, sessões diretas, itens fixados e a fila de tarefas entre projetos sempre visíveis; Yarcy, Configurações e Agendamentos abrem em abas.

<p align="center">
  <a href=".github/assets/workbench-0916-session-menu.png"><img src=".github/assets/workbench-0916-session-menu.png" alt="Menu de contexto de uma linha de sessão com Detalhes da sessão, Colocar sessão em repouso, Reiniciar sessão, Fixar no topo e Remover sessão" width="100%" /></a>
</p>

*Cada linha de sessão carrega todo o seu ciclo de vida, mesmo quando a sessão não está aberta.*

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
