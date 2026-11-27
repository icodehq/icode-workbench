# iCode Workbench

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <strong>Español</strong> ·
  <a href="README.pt-BR.md">Português (BR)</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a>
</p>

<h3 align="center">Todos los agentes. Todas las plataformas. Un solo banco de trabajo.</h3>

<p align="center">
  iCode Workbench es el entorno de desarrollo para flotas de agentes: 44 agentes CLI
  ejecutables trabajan en paralelo, cada uno en su propio worktree de Git. Los bots ven
  proyectos, tareas, sesiones y decisiones de revisión, y te dicen qué necesita tu
  atención. Revisa los cambios en el checkout donde trabajó el agente y conserva la
  terminal aunque la aplicación se reinicie.
</p>

<p align="center">
  <strong>Sin telemetría. Sin cuenta. Sin analítica.</strong><br/>
  iCode no llama a APIs de modelos desde la aplicación; el tráfico de modelos pertenece a
  tu harness. No hay ninguna cuenta que hashear ni datos que enviar.
  <a href="PRIVACY.md">Compruébalo →</a>
</p>

<p align="center">
  <img src=".github/assets/workbench-1127-shell.png" alt="El workbench de iCode con Bots, proyectos y worktrees en la barra lateral, una terminal en vivo, una pestaña de diff abierta y el inspector de Source Control con los cambios del worktree" width="960" />
</p>

## ¿Por qué iCode Workbench?

- **44 agentes CLI ejecutables.** 21 con hooks de estado gestionados, y Claude Code,
  Codex y OpenCode con inyección nativa de proveedor. Cada agente puede correr en
  paralelo en su propio worktree de Git.
- **Todas las plataformas.** Linux (WSL2/WSLg), Windows x64 y macOS x64 / arm64.
- **Aislamiento por defecto.** Cada sesión directa iniciada desde un espacio de trabajo
  aislado nuevo recibe su propia rama y worktree. La carpeta del proyecto es el checkout
  principal del repositorio; solo las sesiones que la eligen explícitamente lo comparten,
  con un aviso permanente.
- **Un worktree es un espacio de trabajo.** Las pestañas de la barra de título reúnen
  terminales, archivos y diffs; las divisiones se anidan y el inspector permanente
  ofrece Files, Search y Source Control.
- **Bots entre proyectos (25 plantillas oficiales, incluida Yarcy).** Cada bot tiene su
  Home Chat y puede entrar en salas de grupo con hilos, modos de respuesta y relevos por
  @mención. Crean, cancelan, reintentan y archivan tareas, pero no pueden aprobar una
  revisión, fusionar ni hacer push.
- **Revisión donde trabajó el agente.** Aceptar una revisión registra el juicio y nunca
  hace commit, merge, push ni borra nada. **Accept & merge…** acepta primero y luego
  abre el selector de merge para confirmar la fusión como un acto aparte.
- **Una barra lateral, dos superficies.** Bots, proyectos y sesiones fijados y el árbol
  de Projects comparten una barra lateral; la campana de needs-you es la cola entre
  proyectos. Un proyecto abre su espacio de Sessions o el banco de trabajo de tareas, y
  Bots, Ajustes y Programaciones se abren como pestañas auxiliares.
- **Terminales que sobreviven a la aplicación.** Un host independiente posee los PTY;
  cerrar la ventana o salir de iCode no detiene a los agentes.
- **Local-first.** El estado vive en SQLite en tu máquina; sin telemetría, sin servicio
  alojado y sin llamadas a modelos desde la aplicación.

<p align="center">
  <a href=".github/assets/workbench-1127-bots.png"><img src=".github/assets/workbench-1127-bots.png" alt="La sala de grupo Atlas crew con una pregunta del propietario, la respuesta de Yarcy, el panel Items a la derecha y el compositor del grupo" width="100%" /></a>
</p>

*Una sala de grupo: menciona a un bot, recibe una respuesta en streaming y mantén el
trabajo pendiente en el panel Items.*

<p align="center">
  <a href=".github/assets/workbench-1127-session-menu.png"><img src=".github/assets/workbench-1127-session-menu.png" alt="Menú contextual de una fila de sesión con Detalles de la sesión, Dormir sesión, Reiniciar sesión, Fijar arriba y Eliminar sesión" width="100%" /></a>
</p>

*Cada fila de sesión lleva todo su ciclo de vida, incluso cuando la sesión no está abierta.*

## Compatibilidad actual

- **Agentes ejecutables:** 44 agentes CLI (incluidos Claude Code, Codex y OpenCode).
- **Inyección nativa de proveedor + conversación de bots:** Claude Code, Codex y OpenCode.
- **Hooks de estado gestionados:** 21 harnesses que muestran trabajo, espera y fin en la
  barra lateral.
- **Plataformas:** Linux (WSL2/WSLg), Windows x64, macOS x64 / arm64.

## Compilar desde el código fuente

**Requisitos:** Node 24.x (`.nvmrc` fija 24.15.0), Corepack con pnpm 11.16.0, Git y al
menos un harness en `PATH`. Linux también necesita `build-essential` y `python3`;
macOS necesita Xcode Command Line Tools.

```bash
git clone https://github.com/icodehq/icode-workbench.git
cd icode-workbench
corepack enable
pnpm install
pnpm dev
```

## Estado

iCode Workbench está en desarrollo experimental temprano y avanza rápidamente. Las
funciones, los esquemas de almacenamiento y el empaquetado pueden cambiar entre versiones.
Usa buenas prácticas de Git en trabajo real y consulta el
[registro de cambios](CHANGELOG.md) antes de actualizar.

> Esta es una traducción resumida. El [README en inglés](README.md) es la fuente autorizada.

[English README](README.md) · [Contribuir](.github/CONTRIBUTING.md) ·
[Seguridad](SECURITY.md) · [Traducciones](TRANSLATIONS.md) · [Registro de cambios](CHANGELOG.md)
