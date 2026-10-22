module.exports = {
  appId: 'dev.ade.app',
  productName: 'ADE',
  directories: {
    output: 'dist'
  },
  files: ['out/**/*', 'package.json'],
  asar: true,
  // Why: the detached host is executed by the Electron binary via ELECTRON_RUN_AS_NODE,
  // so it and its native PTY must exist outside the asar archive.
  asarUnpack: ['out/host/**', 'node_modules/node-pty/**'],
  // Why: node-pty is rebuilt for the Electron ABI by pnpm postinstall/electron-rebuild.
  // electron-builder must not rebuild it for the host Node ABI.
  npmRebuild: false,
  buildDependenciesFromSource: false,
  linux: {
    target: ['dir'],
    executableName: 'ade',
    category: 'Development'
  }
}
