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

<h3 align="center">Execute uma frota de agentes. Coloque os bots para trabalhar. Mantenha o julgamento.</h3>

<p align="center">
  O iCode Workbench é o ambiente de desenvolvimento para frotas de agentes: 44 agentes
  CLI executáveis trabalham em paralelo, cada um em seu próprio worktree do Git. Os bots
  enxergam projetos, tarefas, sessões e decisões de revisão, e não param em uma resposta
  de chat: avançam o trabalho pela fila de tarefas e param na sua revisão. Revise as
  mudanças no checkout onde o agente trabalhou e mantenha o terminal vivo quando o
  aplicativo reiniciar.
</p>

<p align="center">
  <strong>Sem telemetria. Sem conta. Sem análise.</strong><br/>
  O iCode não chama APIs de modelo dentro do aplicativo; o tráfego de modelos pertence ao
  seu harness. Não há conta para gerar hash nem dados para enviar.
  <a href="PRIVACY.md">Verifique →</a>
</p>

<p align="center">
  <img src=".github/assets/workbench-1127-shell.png" alt="O workbench do iCode com Bots, projetos e worktrees na barra lateral, um terminal ao vivo, uma aba de diff aberta e o inspetor de Source Control com as mudanças do worktree" width="960" />
</p>

## Por que iCode Workbench?

- **44 agentes CLI executáveis.** 21 com hooks de status gerenciados, e Claude Code,
  Codex e OpenCode com injeção nativa de provedor. Cada agente pode rodar em paralelo no
  próprio worktree do Git.
- **Todas as plataformas.** Linux (WSL2/WSLg), Windows x64 e macOS x64 / arm64.
- **Isolamento por padrão.** Cada sessão direta iniciada em um novo espaço de trabalho
  isolado recebe sua própria branch e worktree. A pasta do projeto é o checkout principal
  do repositório; apenas sessões que a escolhem explicitamente o compartilham, com um
  aviso permanente.
- **Um worktree é um espaço de trabalho.** As abas na barra de título reúnem terminais,
  arquivos e diffs; as divisões se aninham e o inspetor permanente oferece Files, Search e
  Source Control.
- **Bots entre projetos (25 modelos oficiais, incluindo Yarcy).** Cada bot tem seu Home
  Chat, memória, habilidades e automações, e pode entrar em salas de grupo com threads,
  modos de resposta e repasses por @menção. Criam, cancelam, tentam novamente e arquivam
  tarefas, mas param na sua revisão: não podem aprovar, mesclar nem fazer push.
- **Revisão onde o agente trabalhou.** Aceitar uma revisão registra o julgamento e nunca
  faz commit, merge, push ou exclusão. **Accept & merge…** aceita primeiro e então abre o
  seletor de merge para confirmar a fusão como um ato separado.
- **Uma barra lateral, duas superfícies.** Bots, projetos e sessões fixados e a árvore de
  Projects compartilham a barra lateral; o sino de needs-you é a fila entre projetos. Um
  projeto abre o espaço de Sessions ou a bancada de tarefas, e Bots, Configurações e
  Agendamentos abrem como abas auxiliares.
- **Terminais que sobrevivem ao aplicativo.** Um host independente possui os PTYs;
  fechar a janela ou sair do iCode não para os agentes.
- **Local-first.** O estado fica em SQLite na sua máquina; sem telemetria, sem serviço
  hospedado e sem chamadas a modelos dentro do aplicativo.

<p align="center">
  <a href=".github/assets/workbench-1127-bots.png"><img src=".github/assets/workbench-1127-bots.png" alt="A sala de grupo Atlas crew com uma pergunta do proprietário, a resposta de Yarcy, o painel Items à direita e o compositor do grupo" width="100%" /></a>
</p>

*Uma sala de grupo: mencione um bot, receba uma resposta em streaming e mantenha o
trabalho pendente no painel Items.*

<p align="center">
  <a href=".github/assets/workbench-1127-session-menu.png"><img src=".github/assets/workbench-1127-session-menu.png" alt="Menu de contexto de uma linha de sessão com Detalhes da sessão, Colocar sessão em repouso, Reiniciar sessão, Fixar no topo e Remover sessão" width="100%" /></a>
</p>

*Cada linha de sessão carrega todo o seu ciclo de vida, mesmo quando a sessão não está aberta.*

## Suporte atual

- **Agentes executáveis:** 44 agentes CLI (incluindo Claude Code, Codex e OpenCode).
- **Injeção nativa de provedor + conversa de bots:** Claude Code, Codex e OpenCode.
- **Hooks de status gerenciados:** 21 harnesses que mostram trabalho, espera e conclusão
  na barra lateral.
- **Plataformas:** Linux (WSL2/WSLg), Windows x64, macOS x64 / arm64.

## Compilar a partir do código-fonte

**Requisitos:** Node 24.x (`.nvmrc` fixa 24.15.0), Corepack com pnpm 11.16.0, Git e ao
menos um harness no `PATH`. O Linux também precisa de `build-essential` e `python3`;
o macOS precisa do Xcode Command Line Tools.

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
[Segurança](SECURITY.md) · [Traduções](TRANSLATIONS.md) · [Changelog](CHANGELOG.md)
