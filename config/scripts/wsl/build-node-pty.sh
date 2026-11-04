#!/bin/bash
#
# Builds node-pty from source for Linux against the declared glibc baseline.
# TARGET_ARCH selects x64 (default) or arm64; the container platform must match.
#
# Runs INSIDE an ubuntu:22.04 container (glibc 2.35), driven by
# config/scripts/wsl/host-artifacts.cjs. Every input is pinned by version AND checksum;
# nothing is resolved from a mutable tag at build time.
#
# Why the source is always unpacked at /build/node-pty: gcc records the
# compilation path in debug/string tables. Building at a different path would
# change the artifact bytes without changing its behaviour, which would make the
# reproducibility check meaningless.
set -euo pipefail

NODE_VERSION='v24.21.0'
TARGET_ARCH="${TARGET_ARCH:-x64}"
NODE_PTY_VERSION='1.1.0'
NODE_PTY_SHA256='c7517f19083ddcb05f276904680eb2b11a6b5ecab778b8e4e5685a6d645b3f60'

case "$TARGET_ARCH" in
  x64) DEFAULT_NODE_SHA256='fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6' ;;
  arm64) DEFAULT_NODE_SHA256='6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2' ;;
  *)
    echo "[wsl-host] unsupported TARGET_ARCH: ${TARGET_ARCH}" >&2
    exit 1
    ;;
esac
NODE_SHA256="${NODE_SHA256:-$DEFAULT_NODE_SHA256}"
UBUNTU_CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
OUT_DIR="${OUT_DIR:-/out}"
SOURCE_DIR='/build/node-pty'

export DEBIAN_FRONTEND=noninteractive

log() { printf '[wsl-host] %s\n' "$*" >&2; }

log "baseline: ubuntu ${UBUNTU_CODENAME} glibc $(ldd --version | head -1 | awk '{print $NF}')"

if [ "$(ldd --version | head -1 | awk '{print $NF}')" != '2.35' ]; then
  log "REFUSING to build: expected glibc 2.35, found a different baseline"
  exit 1
fi

# --- toolchain -------------------------------------------------------------
# Versions are recorded, not assumed: the record is what makes a later
# "same inputs" claim checkable.
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends \
  build-essential python3 ca-certificates curl xz-utils file binutils >/dev/null

log "gcc $(gcc -dumpfullversion) make $(make --version | head -1 | awk '{print $3}') python $(python3 -c 'import platform;print(platform.python_version())')"

# --- pinned Node toolchain -------------------------------------------------
curl -sSLo /tmp/node.tar.xz "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${TARGET_ARCH}.tar.xz"
echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c --strict - >/dev/null
tar -xJf /tmp/node.tar.xz -C /opt
export PATH="/opt/node-${NODE_VERSION}-linux-${TARGET_ARCH}/bin:${PATH}"
log "target ${TARGET_ARCH}; node $(node -v) npm $(npm -v) arch $(node -p process.arch)"

# --- pinned node-pty source ------------------------------------------------
curl -sSLo /tmp/node-pty.tgz \
  "https://registry.npmjs.org/node-pty/-/node-pty-${NODE_PTY_VERSION}.tgz"
echo "${NODE_PTY_SHA256}  /tmp/node-pty.tgz" | sha256sum -c --strict - >/dev/null

rm -rf "$SOURCE_DIR" && mkdir -p "$SOURCE_DIR"
tar -xzf /tmp/node-pty.tgz -C "$SOURCE_DIR" --strip-components=1
log "node-pty $(node -p "require('${SOURCE_DIR}/package.json').version") source verified"

# --- build -----------------------------------------------------------------
cd "$SOURCE_DIR"
# Deterministic flags: no path-dependent build id, no host CPU tuning.
export CFLAGS='-O2 -fno-ident'
export CXXFLAGS='-O2 -fno-ident'
export LDFLAGS='-Wl,--build-id=none'

npm install --build-from-source --no-audit --no-fund --no-progress >/tmp/build.log 2>&1 || {
  log 'node-pty build failed; tail of log:'
  tail -30 /tmp/build.log >&2
  exit 1
}

ARTIFACT="${SOURCE_DIR}/build/Release/pty.node"
[ -f "$ARTIFACT" ] || { log 'build produced no pty.node'; exit 1; }
strip --strip-debug "$ARTIFACT" 2>/dev/null || true

# Copy only what the Host needs to load the module: the compiled binary, the
# generated JS, and the package manifest. Build intermediates stay behind.
mkdir -p "${OUT_DIR}/node-pty/build/Release"
cp "$ARTIFACT" "${OUT_DIR}/node-pty/build/Release/pty.node"
cp -r "${SOURCE_DIR}/lib" "${OUT_DIR}/node-pty/lib"
cp "${SOURCE_DIR}/package.json" "${OUT_DIR}/node-pty/package.json"

log "artifact sha256 $(sha256sum "${OUT_DIR}/node-pty/build/Release/pty.node" | cut -d' ' -f1)"
log 'build complete'
