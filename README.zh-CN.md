# iCode Workbench

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português (BR)</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a>
</p>

<h3 align="center">所有智能体。所有平台。一个工作台。</h3>

<p align="center">
  iCode Workbench 是面向多智能体的开发环境：44 个可启动的 CLI 智能体在各自独立的
  Git 工作树中并行工作。Bot 能看到项目、任务、会话和评审状态，告诉你什么需要你处理。
  在智能体工作的 checkout 中审查改动，应用重启后终端仍然存活。
</p>

<p align="center">
  <strong>无遥测。无账号。无分析。</strong><br/>
  iCode 不在应用内调用模型 API；模型流量属于你的 harness。没有账号可哈希，也没有
  任何数据需要上传。<a href="PRIVACY.md">自行验证 →</a>
</p>

<p align="center">
  <img src=".github/assets/workbench-1127-shell.png" alt="iCode Workbench：侧边栏中的 Bots、项目与工作树，实时终端、已打开的 diff 标签，以及右侧列出工作树改动的 Source Control 检查器" width="960" />
</p>

## 为什么选择 iCode Workbench？

- **44 个可启动的 CLI 智能体。** 其中 21 个带托管状态钩子，Claude Code、Codex 和
  OpenCode 支持原生 provider 注入。每个智能体可以并行运行在自己的 Git 工作树中。
- **所有平台。** Linux（WSL2/WSLg）、Windows x64、macOS x64 / arm64。
- **默认隔离。** 从“新建隔离工作区”启动的直接会话都有自己的分支和工作树。项目文件夹是仓库的主 checkout，
  只有显式选择的会话会在其中共享运行，并持续显示共享警告。
- **一个工作树就是一座工作区。** 标题栏中的标签页统一承载终端、文件和 diff；分屏可以
  嵌套，常驻检查器提供 Files、Search 和 Source Control。
- **Bot 跨项目工作（25 个官方模板，含 Yarcy）。** 每个 Bot 有自己的 Home Chat，也可以
  进入带线程、回复模式和 @mention 接力的群组房间。Bot 能创建、取消、重试和归档任务，
  但不能批准评审、合并或推送。
- **在智能体工作的地方评审。** 接受评审只记录你的判断，绝不提交、合并、推送或删除；
  **接受并合并…** 会先接受，再打开合并选择器进行独立的合并确认。
- **一个侧边栏，两个工作面。** Bots、固定项目/会话和 Projects 树共享侧边栏；
  needs-you 铃铛是跨项目队列。项目打开 Sessions 工作区或任务工作台，Bots、设置和
  计划以辅助标签页打开。
- **终端比应用活得久。** 独立 host 持有 PTY，关闭窗口或退出 iCode 不会停止智能体。
- **本地优先。** 状态保存在本机 SQLite；没有遥测、没有托管服务、没有应用内模型调用。

<p align="center">
  <a href=".github/assets/workbench-1127-bots.png"><img src=".github/assets/workbench-1127-bots.png" alt="Atlas crew 群组房间：所有者提问、Yarcy 的回复、右侧的 Items 栏和群组输入框" width="100%" /></a>
</p>

*群组房间：@ 一个 Bot，得到流式回复，并在旁边的 Items 栏中跟踪需要你处理的工作。*

<p align="center">
  <a href=".github/assets/workbench-1127-session-menu.png"><img src=".github/assets/workbench-1127-session-menu.png" alt="会话行右键菜单：会话详情、休眠会话、重启会话、固定到顶部、移除会话" width="100%" /></a>
</p>

*即使没有打开会话，它的整行也承载完整的生命周期操作。*

## 当前支持

- **可启动智能体：** 44 个 CLI 智能体（包括 Claude Code、Codex、OpenCode）。
- **原生 provider 注入 + Bot 对话：** Claude Code、Codex、OpenCode。
- **托管状态钩子：** 21 个 harness，把工作、等待和完成状态显示在侧边栏。
- **平台：** Linux（WSL2/WSLg）、Windows x64、macOS x64 / arm64。

## 从源码构建

**要求：** Node 24.x（`.nvmrc` 固定 24.15.0）、Corepack 与 pnpm 11.16.0、Git，
以及 `PATH` 中至少一个 harness。Linux 还需要 `build-essential` 和 `python3`；
macOS 需要 Xcode Command Line Tools。

```bash
git clone https://github.com/icodehq/icode-workbench.git
cd icode-workbench
corepack enable
pnpm install
pnpm dev
```

## 状态

iCode Workbench 处于早期实验阶段，迭代很快。功能、存储结构和打包方式可能随版本
变化。请在真实项目中使用正常的 Git 工作习惯，并在升级前查看
[更新日志](CHANGELOG.md)。

> 这是翻译概览。英文版 README 是权威来源；完整细节以
> [English README](README.md) 为准。

[English README](README.md) · [参与贡献](.github/CONTRIBUTING.md) ·
[安全政策](SECURITY.md) · [翻译](TRANSLATIONS.md) · [更新日志](CHANGELOG.md)
