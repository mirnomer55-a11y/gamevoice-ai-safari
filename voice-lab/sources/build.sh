#!/usr/bin/env bash
# Build the RHVoice core + wrapper to WebAssembly with Emscripten.
#
# Output: dist/rhvoice.js  + dist/rhvoice.wasm
#
# We compile the C++ core (the explicit source list from src/core/SConscript),
# the bundled hts_engine (C), sonic (C), and our wrapper.cpp. Native audio
# backends are NOT compiled in — the wrapper captures PCM via a client subclass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RH="$ROOT/vendor/RHVoice"
SRC="$RH/src"
OBJ="$ROOT/build/obj"
DIST="$ROOT/dist"
mkdir -p "$OBJ" "$DIST"

# --- 0. Patch a wasm-incompatible signature mismatch --------------------------
# RHVoice's core defines HTS_Audio_initialize() with 3 args while the bundled
# hts_engine declares/calls it with 1. C linkage hides this on native builds,
# but wasm's strict function signatures trap ("unreachable"). Make the
# definition match the 1-arg declaration. Idempotent (no-op once patched).
perl -i -pe \
  's/void HTS_Audio_initialize\(HTS_Audio \* audio, int sampling_rate, int max_buff_size\)/void HTS_Audio_initialize(HTS_Audio * audio)/' \
  "$SRC/core/str_hts_engine_impl.cpp"

# --- 1. Generate the two config.h headers the build normally produces ---------
# Global config (VERSION / ENABLE_SONIC / ENABLE_PKG) — included by headers in
# src/include/core via quote-include.
cat > "$SRC/include/core/config.h" <<'EOF'
#pragma once
#ifndef RHVOICE_GLOBAL_CONFIG_INCLUDED
#define RHVOICE_GLOBAL_CONFIG_INCLUDED
#define ENABLE_SONIC 1
#define ENABLE_PKG 0
const char VERSION[] = "wasm-poc";
#endif
EOF

# Core config (DATA_PATH / CONFIG_PATH) — included by src/core/*.cpp. Values are
# placeholders; the actual paths are passed to rhv_init() at runtime.
cat > "$SRC/core/config.h" <<'EOF'
#pragma once
const char CONFIG_PATH[] = "";
const char DATA_PATH[] = "";
EOF

# --- 2. Include paths ---------------------------------------------------------
INCLUDES=(
  -I"$SRC/include"
  -I"$SRC/include/core"
  -I"$SRC/core"
  -I"$SRC/hts_engine"
  -I"$SRC/third-party/utf8"
  -I"$SRC/third-party/rapidxml"
  -I"$RH/external/libs/sonic"
)
# Modular Boost: each library exposes its own include/ directory.
for d in "$RH"/external/libs/boost/libs/*/include; do
  INCLUDES+=( -I"$d" )
done

# --- 3. Common flags ----------------------------------------------------------
OPT="-O3"
COMMON=( $OPT -fexceptions -DNDEBUG -DAUDIO_PLAY_NONE
         -Wno-deprecated-declarations -Wno-parentheses )
CXXFLAGS=( -std=c++14 "${COMMON[@]}" "${INCLUDES[@]}" )
CFLAGS=(   -std=gnu11 "${COMMON[@]}" "${INCLUDES[@]}" )

# --- 4. Source lists ----------------------------------------------------------
CXX_SRC=(
  unicode.cpp io.cpp path.cpp fst.cpp dtree.cpp lts.cpp item.cpp relation.cpp
  utterance.cpp document.cpp ini_parser.cpp config.cpp engine.cpp params.cpp
  phoneme_set.cpp language.cpp data_only_language.cpp russian.cpp english.cpp
  esperanto.cpp georgian.cpp ukrainian.cpp macedonian.cpp kyrgyz.cpp tatar.cpp
  brazilian_portuguese.cpp userdict.cpp voice.cpp hts_engine_impl.cpp
  hts_vocoder_wrapper.cpp model_answer_cache.cpp str_hts_engine_impl.cpp
  hts_engine_call.cpp hts_label.cpp hts_labeller.cpp speech_processor.cpp
  limiter.cpp bpf.cpp equalizer.cpp unit_db.cpp question_matcher.cpp emoji.cpp
  pitch.cpp english_id.cpp vietnamese.cpp
)

# --- 5. Compile ---------------------------------------------------------------
OBJS=()
compile() {  # <compiler-flags-arrayname> <source-path> <obj-path>
  local out="$3"
  OBJS+=( "$out" )
  if [ "$out" -nt "$2" ] && [ -z "${FORCE:-}" ]; then return; fi
  echo "  CC  $(basename "$2")"
  emcc "${@:4}" -c "$2" -o "$out"
}

echo "Compiling C++ core + wrapper ..."
for f in "${CXX_SRC[@]}"; do
  compile cxx "$SRC/core/$f" "$OBJ/core_${f%.cpp}.o" "${CXXFLAGS[@]}"
done
compile cxx "$ROOT/src/wrapper.cpp" "$OBJ/wrapper.o" "${CXXFLAGS[@]}"

echo "Compiling hts_engine (C) ..."
# Skip HTS_audio.c: the core's str_hts_engine_impl.cpp supplies its own
# HTS_Audio_* implementation (it routes audio to RHVoice, not a device).
for f in "$SRC"/hts_engine/HTS_*.c; do
  [ "$(basename "$f")" = "HTS_audio.c" ] && continue
  b="$(basename "${f%.c}")"
  compile c "$f" "$OBJ/hts_${b}.o" "${CFLAGS[@]}"
done

echo "Compiling sonic (C) ..."
compile c "$RH/external/libs/sonic/sonic.c" "$OBJ/sonic.o" "${CFLAGS[@]}"

# --- 6. Link to wasm ----------------------------------------------------------
echo "Linking dist/rhvoice.js ..."
emcc $OPT -fexceptions "${OBJS[@]}" -o "$DIST/rhvoice.js" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=RHVoiceModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=64MB \
  -s STACK_SIZE=5MB \
  -s FORCE_FILESYSTEM=1 \
  -lidbfs.js \
  -lnodefs.js \
  -s EXIT_RUNTIME=0 \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS","IDBFS","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAP16"]' \
  -s EXPORTED_FUNCTIONS='["_rhv_init","_rhv_speak","_rhv_samples_ptr","_rhv_sample_count","_rhv_sample_rate","_rhv_voices","_rhv_last_error","_malloc","_free"]'

echo "Done. Artifacts in dist/:"
ls -lh "$DIST"
