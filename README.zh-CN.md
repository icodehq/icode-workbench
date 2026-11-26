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
  iCode Workbench 是通用的智能体开发环境（ADE）：Claude Code、Codex 和 OpenCode
  可以并行运行，每个会话都拥有独立的 Git 工作树。Yarcy 跨项目观察所有仓库，告诉你
  什么需要你处理，并能在项目之间执行操作。在智能体工作的地方审查改动，并让终端在
  应用重启后继续运行。
</p>

<p align="center">
  <strong>无遥测。无账号。无分析。</strong><br/>
  T3 Code 目前会将你的 OpenAI 和 Claude 账号 ID 哈希后连同稳定的安装 ID 转发给 PostHog。
  iCode 没有账号可哈希——没有任何东西可发送。<a href="PRIVACY.md">自行验证 →</a>
</p>

<p align="center">
  <img src=".github/assets/workbench-0916-shell.png" alt="iCode Workbench 工作台：项目与任务侧边栏、应用与会话标签页、实时终端，以及检查器中的 Source Control 差异" width="960" />
</p>

## 隐私默认

iCode 是本地优先的。应用本身不收集任何分析、遥测、使用事件、账号 ID、安装 ID 或设备 ID；提示词、代码、文件路径和会话 ID 不会经由 iCode 离开你的机器。

| 调用 | 何时 | 发送什么 | 发往哪里 |
|---|---|---|---|
| 更新检查 | 启动时和定期 | 标准更新请求中的应用版本和平台 | GitHub Releases |
| 智能体 CLI | 运行 harness 时 | 该 CLI 发给其厂商和你配置的 provider 的内容 | CLI 厂商 / 你的 provider |
| Git | fetch / push 时 | 仓库数据 | 你配置的 remote |
| 诊断 | 仅当你选择复制或导出 | 诊断视图显示的内容 | 你发送到的地方 |

**与 T3 Code 的对比：** T3 Code 的遥测文档（2026 年 11 月）描述了哈希后的 T3 Connect / OpenAI / Claude 账号 ID、稳定的安装 ID、每设备 ID，以及向 PostHog 转发——默认开启，可用环境变量关闭。iCode 没有这些：没有账号、没有安装 ID、没有分析端点。[逐项对比 →](PRIVACY.md#how-t3-code-compares)

**自行验证：** [PRIVACY.md](PRIVACY.md) 列出了每一次对外调用；`scripts/audit-telemetry.sh` 在 CI 中运行，一旦加入分析 SDK 或端点就会失败。

**承诺：** iCode 永远不会加入遥测。如果未来改变，一定会是 opt-in、默认关闭，并在 changelog 中公告。

## 为什么选择 iCode Workbench？

- **一个工作台，支持所有智能体。** 今天支持 Claude Code、Codex 和 OpenCode；
  适配器模型可以继续接入更多 harness。
- **支持所有平台。** Linux（WSL2/WSLg）、Windows x64、macOS x64 / arm64。
- **默认并行。** 每个会话都有独立的分支和 Git 工作树。
- **每个会话行都是操作面板。** 无需打开会话，右键即可查看详情、休眠或唤醒、重启、
  固定和移除。移除无需输入分支名，会列明受影响的改动，并始终保留分支。
- **跨项目的 Yarcy（默认名，可随时改名）。** 一个对话覆盖任务队列、阻塞事项和跨项目操作。
- **在智能体工作的地方审查。** 任务 diff、文件、搜索和 Source Control 都在同一个
  session checkout 中。
- **一个侧边栏掌握全部工作。** 项目、直连会话、置顶项和跨项目任务队列始终可见；Yarcy、设置和计划以标签页打开。

<p align="center">
  <a href=".github/assets/workbench-0916-session-menu.png"><img src=".github/assets/workbench-0916-session-menu.png" alt="会话行右键菜单：会话详情、休眠会话、重启会话、固定到顶部、移除会话" width="100%" /></a>
</p>

*即使没有打开会话，它的整行也承载完整的生命周期操作。*

## 当前支持

- **智能体：** Claude Code、Codex、OpenCode
- **平台：** Linux（WSL2/WSLg）、Windows x64、macOS x64 / arm64

## 从源码构建

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
[安全政策](SECURITY.md) · [更新日志](CHANGELOG.md)
