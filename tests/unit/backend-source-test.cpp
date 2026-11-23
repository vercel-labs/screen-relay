#include "core/capture.hpp"
#include "core/wait.hpp"
extern "C" {
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
}
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

using namespace std::chrono_literals;
static void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}
struct SourceState {
  relay::Wake wake;
  std::atomic<unsigned> captures{0};
  std::atomic<bool> red{false};
  std::atomic<int> width{0}, height{0};
  int invalid = 0;
  SourceState() { require(wake.valid(), "damage wake unavailable"); }
  void damage() { wake.signal(); }
};
// This source has no display connection or native-backend factory dependency.
class CpuSource final : public relay::CaptureSource {
  std::shared_ptr<SourceState> state;
  int width, height;
  std::vector<uint8_t> pixels;
 public:
  explicit CpuSource(std::shared_ptr<SourceState> s, int w = 1280, int h = 720)
      : state(std::move(s)), width(w), height(h), pixels(size_t(w) * size_t(h) * 4) {}
  relay::WaitHandle fd() const override { return state->wake.handle(); }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  bool resized() const override { return state->width && (state->width != width || state->height != height); }
  bool drainDamage() override { return state->wake.consume(); }
  relay::PixelFormat pixelFormat() const override { return relay::PixelFormat::BGRA; }
  relay::FrameView capture() override {
    ++state->captures;
    const bool red = state->red.load();
    for (size_t i = 0; i < pixels.size(); i += 4) {
      pixels[i] = red ? 48 : 96; pixels[i + 1] = red ? 64 : 176;
      pixels[i + 2] = red ? 192 : 32; pixels[i + 3] = 255;
    }
    return {pixels.data(), state->invalid == 2 ? 1 : width * 4,
            state->invalid == 1 ? 1 : width, height, relay::PixelFormat::BGRA};
  }
};
struct Frames {
  std::mutex mutex;
  std::condition_variable changed;
  std::vector<relay::EncodedFrame> items;
  bool publish(relay::EncodedFrame&& frame) {
    { std::lock_guard<std::mutex> lock(mutex); items.push_back(std::move(frame)); }
    changed.notify_all(); return true;
  }
  relay::EncodedFrame at(size_t index) {
    std::unique_lock<std::mutex> lock(mutex);
    require(changed.wait_for(lock, 3s, [&] { return items.size() > index; }), "encoded frame timeout");
    return items[index];
  }
};
static void decodedPixel(const relay::EncodedFrame& encoded, bool red, int width, int height) {
  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  require(codec, "H264 decoder unavailable");
  AVCodecContext* decoder = avcodec_alloc_context3(codec);
  AVFrame* frame = av_frame_alloc();
  AVPacket* packet = av_packet_alloc();
  SwsContext* converter = nullptr;
  try {
    require(decoder && frame && packet, "decoder allocation failed");
    require(avcodec_open2(decoder, codec, nullptr) >= 0, "decoder open failed");
    require(av_new_packet(packet, int(encoded.annex_b.size())) >= 0, "packet allocation failed");
    std::copy(encoded.annex_b.begin(), encoded.annex_b.end(), packet->data);
    require(avcodec_send_packet(decoder, packet) >= 0, "decoder rejected IDR");
    require(avcodec_receive_frame(decoder, frame) >= 0, "fresh decoder could not decode IDR");
    require(frame->width == width && frame->height == height, "decoded dimensions differ");
    converter = sws_getContext(width, height, AVPixelFormat(frame->format), width, height,
                              AV_PIX_FMT_RGB24, SWS_POINT, nullptr, nullptr, nullptr);
    require(converter, "RGB decoder conversion failed");
    const int* coefficients = sws_getCoefficients(SWS_CS_ITU709);
    require(sws_setColorspaceDetails(converter, coefficients, 0, coefficients, 1,
                                    0, 1 << 16, 1 << 16) >= 0, "decoder colorspace failed");
    std::vector<uint8_t> rgb(size_t(width) * height * 3);
    uint8_t* planes[] = {rgb.data(), nullptr, nullptr, nullptr};
    int strides[] = {width * 3, 0, 0, 0};
    require(sws_scale(converter, frame->data, frame->linesize, 0, height, planes, strides) == height,
            "decoded RGB conversion incomplete");
    const int expected[] = {red ? 192 : 32, red ? 64 : 176, red ? 48 : 96};
    for (int channel = 0; channel < 3; ++channel)
      require(std::abs(int(rgb[(size_t(height) / 2 * width + width / 2) * 3 + channel]) - expected[channel]) <= 12,
              "decoded source pixel differs from independent RGB expectation");
  } catch (...) {
    sws_freeContext(converter); av_packet_free(&packet); av_frame_free(&frame);
    avcodec_free_context(&decoder); throw;
  }
  sws_freeContext(converter); av_packet_free(&packet); av_frame_free(&frame);
  avcodec_free_context(&decoder);
}
static const relay::CaptureSettings capture_settings{60, 1000000, 8000000, 40000000};
static void healthySource() {
  auto state = std::make_shared<SourceState>(); Frames frames;
  relay::CaptureEncoder encoder([&](relay::EncodedFrame&& f) { return frames.publish(std::move(f)); },
      capture_settings, [state] { return std::make_unique<CpuSource>(state); });
  std::string error;
  require(encoder.start(error), error.c_str());
  require(state->captures == 0, "capture occurred with no session");
  encoder.beginSession(17);
  const auto initial = frames.at(0);
  require(initial.generation == 17 && initial.sequence == 1 && initial.keyframe,
          "initial session did not start with sequence-one keyframe");
  decodedPixel(initial, false, 1280, 720);
  encoder.acknowledge(17, 1);
  const unsigned captured = state->captures;
  std::this_thread::sleep_for(150ms);
  require(state->captures == captured, "idle source caused extra capture");
  state->red = true; state->damage();
  const auto changed = frames.at(1);
  require(changed.generation == 17 && changed.sequence == 2 && changed.pts_us > initial.pts_us,
          "damage did not produce ordered fresh frame");
  encoder.endSession(17); encoder.beginSession(18);
  const auto fresh = frames.at(2);
  require(fresh.generation == 18 && fresh.sequence == 1 && fresh.keyframe,
          "new generation did not reset sequence and IDR");
  decodedPixel(fresh, true, 1280, 720);
  encoder.stop();
  const unsigned stopped = state->captures;
  state->damage(); std::this_thread::sleep_for(50ms);
  require(state->captures == stopped, "capture continued after shutdown");
  require(encoder.error().empty(), "healthy source produced fatal error");
}
static void waitFor(const std::atomic<unsigned>& counter, unsigned value, const char* message) {
  for (int i = 0; i < 300 && counter < value; ++i) std::this_thread::sleep_for(10ms);
  require(counter >= value, message);
}
static void sourceResize() {
  auto state = std::make_shared<SourceState>(); Frames frames;
  state->width = 1280; state->height = 720;
  std::atomic<unsigned> resizes{0};
  relay::CaptureEncoder encoder([&](relay::EncodedFrame&& f) { return frames.publish(std::move(f)); },
      capture_settings,
      [state] { return std::make_unique<CpuSource>(state, state->width, state->height); }, {},
      [&] { ++resizes; });
  std::string error;
  require(encoder.start(error), error.c_str());
  encoder.beginSession(17);
  const auto initial = frames.at(0);
  require(initial.generation == 17 && initial.keyframe && initial.width == 1280 && initial.height == 720,
          "initial session did not start at the source size");
  encoder.acknowledge(17, 1);
  state->width = 1920; state->height = 1080; state->damage();
  waitFor(resizes, 1, "resize was not reported");
  require(encoder.dimensions() == std::make_pair(1920, 1080), "encoder kept the old size");
  std::this_thread::sleep_for(100ms);
  require(frames.items.size() == 1, "frame published before the new generation began");
  encoder.beginSession(18);
  const auto resized = frames.at(1);
  require(resized.generation == 18 && resized.sequence == 1 && resized.keyframe &&
          resized.width == 1920 && resized.height == 1080, "new generation did not start with a keyframe at the new size");
  decodedPixel(resized, false, 1920, 1080);
  encoder.acknowledge(18, 1);
  state->width = 200; state->damage();
  for (int i = 0; i < 300 && encoder.error().empty(); ++i) std::this_thread::sleep_for(10ms);
  require(encoder.error().find("Unsupported root size 200x1080") != std::string::npos,
          "unsupported resize did not report the size");
  encoder.stop();
}
static void runtimeSize(int width, int height, unsigned fps = 60) {
  auto state = std::make_shared<SourceState>(); Frames frames;
  auto settings = capture_settings;
  settings.fps = fps;
  relay::CaptureEncoder encoder([&](relay::EncodedFrame&& frame) { return frames.publish(std::move(frame)); },
      settings, [state, width, height] { return std::make_unique<CpuSource>(state, width, height); });
  std::string error; require(encoder.start(error), error.c_str()); encoder.beginSession(20);
  const auto initial = frames.at(0);
  require(initial.width == width && initial.height == height && initial.keyframe,
          "runtime source dimensions were not encoded");
  if (fps == 120) {
    bool level_supported = false;
    const auto& bytes = initial.annex_b;
    for (size_t i = 0; i + 6 < bytes.size(); ++i)
      if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1 &&
          (bytes[i + 3] & 31) == 7) {
        level_supported = bytes[i + 6] >= 42;
        break;
      }
    require(level_supported, "720p120 SPS level is below 4.2");
  }
  decodedPixel(initial, false, width, height);
  encoder.acknowledge(20, 1);
  state->red = true; state->damage();
  const auto changed = frames.at(1);
  require(changed.width == width && changed.height == height && !changed.keyframe,
          "damage frame at runtime dimensions was not encoded");
  encoder.stop();
}
static void identicalDamageRefines() {
  auto state = std::make_shared<SourceState>(); Frames frames;
  relay::CaptureEncoder encoder([&](relay::EncodedFrame&& frame) { return frames.publish(std::move(frame)); },
      capture_settings, [state] { return std::make_unique<CpuSource>(state); });
  std::string error; require(encoder.start(error), error.c_str()); encoder.beginSession(19);
  frames.at(0);
  encoder.setFlowControl(19, 2, 8000000, false, 0);
  const auto blocked_until = std::chrono::steady_clock::now() + 200ms;
  while (std::chrono::steady_clock::now() < blocked_until) {
    state->damage(); std::this_thread::sleep_for(2ms);
  }
  { std::lock_guard<std::mutex> lock(frames.mutex);
    require(frames.items.size() == 1, "refinement ran with a frame in flight");
  }
  state->damage(); encoder.acknowledge(19, 1);
  bool refined = false;
  const auto timeout = std::chrono::steady_clock::now() + 2s;
  while (std::chrono::steady_clock::now() < timeout) {
    state->damage(); std::this_thread::sleep_for(2ms);
    std::lock_guard<std::mutex> lock(frames.mutex);
    if (frames.items.size() > 1) { refined = true; break; }
  }
  require(refined, "identical damage starved refinement");
  require(state->captures > 2, "identical damage was not captured");
  encoder.stop();
}
static void invalidSource(int invalid) {
  auto state = std::make_shared<SourceState>(); state->invalid = invalid;
  std::atomic<unsigned> published{0};
  relay::CaptureEncoder encoder([&](relay::EncodedFrame&&) { ++published; return true; },
      capture_settings, [state] { return std::make_unique<CpuSource>(state); });
  std::string error; require(encoder.start(error), error.c_str()); encoder.beginSession(1);
  const auto deadline = std::chrono::steady_clock::now() + 4s;
  while (encoder.error().empty() && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(20ms);
  require(encoder.error().find("invalid capture frame") != std::string::npos,
          "invalid source did not fail within bounded retries");
  encoder.stop(); require(published == 0 && state->captures == 3,
                          "invalid source published or retried without bound");
}
class StripeSource final : public relay::CaptureSource {
  std::shared_ptr<SourceState> state;
  int width, height;
  std::vector<uint8_t> pixels;
 public:
  StripeSource(std::shared_ptr<SourceState> s, int w, int h)
      : state(std::move(s)), width(w), height(h), pixels(size_t(w) * size_t(h) * 4) {}
  static int shade(int y) { return 40 + (y / 16) * 37 % 176; }
  relay::WaitHandle fd() const override { return state->wake.handle(); }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  bool resized() const override { return state->width && (state->width != width || state->height != height); }
  bool drainDamage() override { return state->wake.consume(); }
  relay::PixelFormat pixelFormat() const override { return relay::PixelFormat::BGRA; }
  relay::FrameView capture() override {
    ++state->captures;
    const bool stripes = state->red.load();
    for (int y = 0; y < height; ++y)
      for (int x = 0; x < width; ++x) {
        uint8_t* p = pixels.data() + (size_t(y) * width + x) * 4;
        p[0] = p[1] = p[2] = uint8_t(stripes ? shade(y) : 128); p[3] = 255;
      }
    return {pixels.data(), width * 4, width, height, relay::PixelFormat::BGRA};
  }
};
static void decodedStripes(const std::vector<relay::EncodedFrame>& sequence, int width, int height) {
  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  require(codec, "H264 decoder unavailable");
  AVCodecContext* decoder = avcodec_alloc_context3(codec);
  AVFrame* frame = av_frame_alloc();
  AVPacket* packet = av_packet_alloc();
  try {
    require(decoder && frame && packet && avcodec_open2(decoder, codec, nullptr) >= 0, "decoder open failed");
    for (const auto& encoded : sequence) {
      require(av_new_packet(packet, int(encoded.annex_b.size())) >= 0, "packet allocation failed");
      std::copy(encoded.annex_b.begin(), encoded.annex_b.end(), packet->data);
      require(avcodec_send_packet(decoder, packet) >= 0, "decoder rejected frame");
      require(avcodec_receive_frame(decoder, frame) >= 0, "decoder did not return the frame");
      av_packet_unref(packet);
    }
    require(frame->width == width && frame->height == height, "decoded dimensions differ");
    for (int y = 8; y < height; y += 16) {
      const int luma = frame->data[0][size_t(y) * frame->linesize[0] + width / 2];
      const int expected = 16 + 219 * StripeSource::shade(y) / 255;
      require(std::abs(luma - expected) <= 6, "a band of the damaged frame decoded to the wrong shade");
    }
  } catch (...) {
    av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&decoder); throw;
  }
  av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&decoder);
}
static void fullScreenDamage(int width, int height) {
  auto state = std::make_shared<SourceState>(); Frames frames;
  relay::CaptureEncoder encoder([&](relay::EncodedFrame&& f) { return frames.publish(std::move(f)); },
      capture_settings, [state, width, height] { return std::make_unique<StripeSource>(state, width, height); });
  std::string error; require(encoder.start(error), error.c_str()); encoder.beginSession(21);
  const auto initial = frames.at(0);
  encoder.acknowledge(21, 1);
  state->red = true; state->damage();
  const auto changed = frames.at(1);
  require(!changed.keyframe, "full-screen damage was not encoded as a delta frame");
  encoder.stop();
  decodedStripes({initial, changed}, width, height);
}
static void scaledSurfaceFitsLevel52(int width, int height, unsigned fps) {
  auto state = std::make_shared<SourceState>(); Frames frames;
  relay::CaptureSettings settings = capture_settings;
  settings.fps = fps;
  relay::CaptureEncoder encoder([&](relay::EncodedFrame&& f) { return frames.publish(std::move(f)); },
      settings, [state, width, height] { return std::make_unique<CpuSource>(state, width, height); });
  std::string error; require(encoder.start(error), error.c_str());
  const auto stream = encoder.dimensions();
  require(stream.first < width && stream.second < height, "oversized surface was not scaled down");
  encoder.beginSession(22);
  const auto initial = frames.at(0);
  require(initial.width == stream.first && initial.height == stream.second && initial.keyframe,
          "scaled initial IDR dimensions mismatch");
  uint8_t sps_level = 0;
  const auto& bytes = initial.annex_b;
  for (size_t i = 0; i + 6 < bytes.size(); ++i) {
    if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1 && (bytes[i + 3] & 31) == 7) {
      sps_level = bytes[i + 6];
      break;
    }
  }
  require(sps_level > 0 && sps_level <= 52, "scaled stream SPS level exceeds H.264 level 5.2");
  decodedPixel(initial, false, stream.first, stream.second);
  encoder.stop();
}
int main() {
  try {
    healthySource(); sourceResize(); runtimeSize(1920, 1080); runtimeSize(1366, 768); runtimeSize(3840, 2160);
    runtimeSize(1280, 720, 120);
    scaledSurfaceFitsLevel52(6016, 3384, 60);
    scaledSurfaceFitsLevel52(3008, 1692, 120);
    fullScreenDamage(1920, 1080); fullScreenDamage(1366, 768);
    identicalDamageRefines(); invalidSource(1); invalidSource(2);
    std::puts("backend source: decoded fresh IDRs, damage, refinement, idle, shutdown and invalid frames passed");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "backend source: %s\n", error.what()); return 1;
  }
}
