# iCode Workbench

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <strong>한국어</strong> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português (BR)</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a>
</p>

<h3 align="center">모든 에이전트. 모든 플랫폼. 하나의 워크벤치.</h3>

<p align="center">
  iCode Workbench는 유니버설 에이전트 개발 환경(ADE)입니다. Claude Code, Codex,
  OpenCode를 병렬로 실행하고 각 세션에 독립적인 Git 워크트리를 제공합니다. Mira는 모든
  저장소를 넘나들며 지켜보고, 무엇이 필요한지 알려주며, 프로젝트 전반에서 작업할 수
  있습니다. 에이전트가 작업한 곳에서 변경 사항을 리뷰하고, 앱을 다시 시작해도 터미널을
  유지합니다.
</p>

<p align="center">
  <img src=".github/assets/projects-wall.png" alt="iCode Workbench 프로젝트 월: 세 개의 WSL 프로젝트에서 실행 중인 세션, 주의가 필요한 항목, 최근 활동" width="960" />
</p>

## iCode Workbench를 선택하는 이유

- **모든 에이전트를 하나의 워크벤치에서.** 현재 Claude Code, Codex, OpenCode를
  지원하며, 어댑터 모델로 더 많은 harness를 추가할 수 있습니다.
- **모든 플랫폼.** Linux(WSL2/WSLg), Windows x64, macOS x64 / arm64.
- **기본이 병렬 실행.** 모든 세션은 자체 브랜치와 Git 워크트리를 받습니다.
- **프로젝트를 넘나드는 Mira.** 대기열, 블로커, 프로젝트 간 작업을 하나의 대화에서.
- **에이전트가 작업한 곳에서 리뷰.** 작업 diff, Source Control, Monaco가 같은
  세션 체크아웃에 있습니다.

## 현재 지원

- **에이전트:** Claude Code, Codex, OpenCode
- **플랫폼:** Linux(WSL2/WSLg), Windows x64, macOS x64 / arm64

## 소스에서 빌드

```bash
git clone https://github.com/icodehq/icode-workbench.git
cd icode-workbench
corepack enable
pnpm install
pnpm dev
```

## 상태

iCode Workbench는 초기 실험 단계이며 빠르게 반복하고 있습니다. 기능, 저장소 스키마,
패키징 방식은 릴리스마다 바뀔 수 있습니다. 실제 작업에서는 일반적인 Git 습관을 지키고,
업그레이드 전에 [변경 로그](CHANGELOG.md)를 확인하세요.

> 이 문서는 번역된 개요입니다. 권위 있는 원문은 [English README](README.md)입니다.

[English README](README.md) · [기여하기](.github/CONTRIBUTING.md) ·
[보안](SECURITY.md) · [변경 로그](CHANGELOG.md)
