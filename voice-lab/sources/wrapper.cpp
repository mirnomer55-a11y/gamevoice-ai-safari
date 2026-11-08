/* Emscripten wrapper around the RHVoice C++ core.
 *
 * Exposes a tiny C ABI that JavaScript can drive:
 *   - rhv_init(data_path, config_path): build the engine over a data dir
 *     mounted in the Emscripten virtual FS (contains languages/ and voices/).
 *   - rhv_speak(text, voice_spec): synthesize UTF-8 text with the given voice
 *     (e.g. "mil" / "mia"); PCM is captured into a buffer.
 *   - rhv_samples_ptr/rhv_sample_count/rhv_sample_rate: read the captured
 *     16-bit mono PCM so JS can hand it to the Web Audio API.
 *
 * We bypass RHVoice's native audio backends entirely: our client subclass just
 * collects the samples that the synthesizer would otherwise have played.
 */

#include <string>
#include <vector>
#include <memory>
#include <exception>

#include <emscripten/emscripten.h>

#include "core/engine.hpp"
#include "core/document.hpp"
#include "core/client.hpp"
#include "core/voice_profile.hpp"

using namespace RHVoice;

namespace {

// Collects the PCM the engine produces instead of playing it.
class capture_client : public client {
public:
  std::vector<short> samples;
  int sample_rate = 24000;

  bool play_speech(const short* s, std::size_t count) override {
    samples.insert(samples.end(), s, s + count);
    return true;  // keep synthesizing
  }

  bool set_sample_rate(int sr) override {
    sample_rate = sr;
    return true;
  }

  void reset() { samples.clear(); }
};

std::shared_ptr<engine> g_engine;
capture_client g_client;
std::string g_error;
std::string g_voices;  // backing store for rhv_voices()

}  // namespace

extern "C" {

// Returns 0 on success, negative on failure. Inspect rhv_last_error() on error.
EMSCRIPTEN_KEEPALIVE
int rhv_init(const char* data_path, const char* config_path) {
  try {
    engine::init_params p;
    if (data_path && *data_path)
      p.data_path = data_path;
    // RHVoice's path::join rejects empty components, so config_path must be
    // non-empty even though we ship no config files. Fall back to data_path.
    if (config_path && *config_path)
      p.config_path = config_path;
    else
      p.config_path = p.data_path;
    g_engine = engine::create(p);
    // Cache the available voice names for debugging / UI.
    g_voices.clear();
    for (const auto& v : g_engine->get_voices()) {
      if (!g_voices.empty())
        g_voices += ",";
      g_voices += v.get_name();
    }
    return 0;
  } catch (const std::exception& e) {
    g_error = e.what();
    g_engine.reset();
    return -1;
  } catch (...) {
    g_error = "unknown error during init";
    g_engine.reset();
    return -2;
  }
}

// Synthesize `text` with voice `voice_spec` (e.g. "mil"). rate/pitch/volume are
// relative multipliers (1.0 == default). When `ssml` is non-zero, `text` is
// parsed as SSML (e.g. <speak>…<break time="500ms"/>…</speak>) instead of plain
// text. Returns the number of PCM samples produced, or negative on error.
EMSCRIPTEN_KEEPALIVE
int rhv_speak(const char* text, const char* voice_spec,
              double rate, double pitch, double volume, int ssml) {
  if (!g_engine) {
    g_error = "engine not initialized";
    return -1;
  }
  try {
    g_client.reset();
    std::string s(text ? text : "");
    voice_profile profile;
    if (voice_spec && *voice_spec)
      profile = g_engine->create_voice_profile(voice_spec);
    if (profile.empty()) {
      g_error = std::string("voice not found: ") + (voice_spec ? voice_spec : "");
      return -2;
    }
    std::unique_ptr<document> doc =
        ssml ? document::create_from_ssml(g_engine, s.begin(), s.end(), profile)
             : document::create_from_plain_text(g_engine, s.begin(), s.end(),
                                                 content_text, profile);
    if (rate > 0)   doc->speech_settings.relative.rate = rate;
    if (pitch > 0)  doc->speech_settings.relative.pitch = pitch;
    if (volume > 0) doc->speech_settings.relative.volume = volume;
    doc->set_owner(g_client);
    doc->synthesize();
    return static_cast<int>(g_client.samples.size());
  } catch (const std::exception& e) {
    g_error = e.what();
    return -3;
  } catch (...) {
    g_error = "unknown error during synthesis";
    return -4;
  }
}

EMSCRIPTEN_KEEPALIVE
const short* rhv_samples_ptr() { return g_client.samples.data(); }

EMSCRIPTEN_KEEPALIVE
int rhv_sample_count() { return static_cast<int>(g_client.samples.size()); }

EMSCRIPTEN_KEEPALIVE
int rhv_sample_rate() { return g_client.sample_rate; }

EMSCRIPTEN_KEEPALIVE
const char* rhv_voices() { return g_voices.c_str(); }

EMSCRIPTEN_KEEPALIVE
const char* rhv_last_error() { return g_error.c_str(); }

}  // extern "C"
