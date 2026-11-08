#!/usr/bin/env bash
# Fetch the upstream sources this project builds from, into vendor/:
#   - RHVoice core (master; includes the Luxembourgish language registration),
#   - the Mil and Mia voice packs,
#   - the English slt voice pack,
#   - the compiled Luxembourgish language data,
#   - RHVoice's bundled header-only Boost + sonic (git submodules).
# Idempotent: existing clones are left in place.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
V="$ROOT/vendor"
mkdir -p "$V"

clone() {  # <url> <dir>
  if [ -d "$V/$2/.git" ]; then
    echo "vendor/$2 already present — skipping clone"
  else
    git clone --depth 1 "$1" "$V/$2"
  fi
}

clone https://github.com/RHVoice/RHVoice                       RHVoice
clone https://github.com/louderpages/RHVoice-Mil               RHVoice-Mil
clone https://github.com/louderpages/RHVoice-Mia               RHVoice-Mia
clone https://github.com/louderpages/RHVoice-Luxembourgish-bin RHVoice-Luxembourgish-bin
clone https://github.com/RHVoice/English English
clone https://github.com/RHVoice/slt-eng slt-eng

# Bundled dependencies (submodules of the RHVoice repo): header-only Boost + sonic.
echo "Initializing Boost + sonic submodules…"
git -C "$V/RHVoice" submodule update --init --depth 1 \
  external/libs/boost/libs/* external/libs/sonic

echo "Vendoring complete."
