#include "core/capture.hpp"
#include "core/wait.hpp"
#ifdef __APPLE__
#include <CoreVideo/CoreVideo.h>
#endif
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
#include <cstring>
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
  bool publish(std::shared_ptr<const relay::EncodedFrame> frame) {
    { std::lock_guard<std::mutex> lock(mutex); items.push_back(*frame); }
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
  relay::CaptureEncoder encoder([&](std::shared_ptr<const relay::EncodedFrame> f) { return frames.publish(std::move(f)); },
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
static void runtimeSize(int width, int height, unsigned fps = 60) {
  auto state = std::make_shared<SourceState>(); Frames frames;
  auto settings = capture_settings;
  settings.fps = fps;
  relay::CaptureEncoder encoder([&](std::shared_ptr<const relay::EncodedFrame> frame) { return frames.publish(std::move(frame)); },
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
  relay::CaptureEncoder encoder([&](std::shared_ptr<const relay::EncodedFrame> frame) { return frames.publish(std::move(frame)); },
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
  relay::CaptureEncoder encoder([&](std::shared_ptr<const relay::EncodedFrame>) { ++published; return true; },
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
  relay::CaptureEncoder encoder([&](std::shared_ptr<const relay::EncodedFrame> f) { return frames.publish(std::move(f)); },
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
#ifdef __APPLE__
class NativeGraySource final : public relay::CaptureSource {
  std::shared_ptr<SourceState> state;
  int width, height;
  std::vector<uint8_t> pixels;
  CVPixelBufferRef buffer = nullptr;
 public:
  NativeGraySource(std::shared_ptr<SourceState> s, int w, int h)
      : state(std::move(s)), width(w), height(h), pixels(size_t(w) * size_t(h) * 4, 128) {
    for (size_t i = 3; i < pixels.size(); i += 4) pixels[i] = 255;
    CFDictionaryRef io_props = CFDictionaryCreate(nullptr, nullptr, nullptr, 0,
                                                  &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    const void* keys[] = {kCVPixelBufferIOSurfacePropertiesKey};
    const void* values[] = {io_props};
    CFDictionaryRef attrs = CFDictionaryCreate(nullptr, keys, values, 1,
                                               &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    const CVReturn created = CVPixelBufferCreate(nullptr, size_t(w), size_t(h), kCVPixelFormatType_32BGRA, attrs, &buffer);
    CFRelease(attrs);
    CFRelease(io_props);
    require(created == kCVReturnSuccess && buffer != nullptr, "CVPixelBufferCreate failed");
    require(CVPixelBufferLockBaseAddress(buffer, 0) == kCVReturnSuccess, "CVPixelBufferLockBaseAddress failed");
    auto* dst = static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(buffer));
    const size_t dst_stride = CVPixelBufferGetBytesPerRow(buffer);
    const size_t row_bytes = size_t(w) * 4;
    for (int y = 0; y < h; ++y) std::memcpy(dst + size_t(y) * dst_stride, pixels.data() + size_t(y) * row_bytes, row_bytes);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
  }
  ~NativeGraySource() override {
    if (buffer) CVPixelBufferRelease(buffer);
  }
  relay::WaitHandle fd() const override { return state->wake.handle(); }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  bool drainDamage() override { return state->wake.consume(); }
  relay::PixelFormat pixelFormat() const override { return relay::PixelFormat::BGRA; }
  relay::FrameView capture() override {
    ++state->captures;
    return {pixels.data(), width * 4, width, height, relay::PixelFormat::BGRA};
  }
  relay::FrameView captureNative(bool) override {
    ++state->captures;
    CVPixelBufferRetain(buffer);
    relay::FrameView view{};
    view.width = width;
    view.height = height;
    view.format = relay::PixelFormat::BGRA;
    view.native_handle = buffer;
    return view;
  }
  void releaseNative(void* handle) override {
    if (handle) CVPixelBufferRelease(static_cast<CVPixelBufferRef>(handle));
  }
};
static void zeroCopyRefinementPreservesImage() {
  auto state = std::make_shared<SourceState>(); Frames frames;
  relay::CaptureEncoder encoder([&](std::shared_ptr<const relay::EncodedFrame> f) { return frames.publish(std::move(f)); },
      capture_settings, [state] { return std::make_unique<NativeGraySource>(state, 640, 360); });
  std::string error; require(encoder.start(error), error.c_str()); encoder.beginSession(22);
  const auto initial = frames.at(0);
  encoder.acknowledge(22, 1);
  const auto refined = frames.at(1);
  require(!refined.keyframe, "zero-copy refinement was not encoded as a delta frame");
  encoder.stop();
  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  require(codec, "H264 decoder unavailable");
  AVCodecContext* decoder = avcodec_alloc_context3(codec);
  AVFrame* frame = av_frame_alloc();
  AVPacket* packet = av_packet_alloc();
  try {
    require(decoder && frame && packet && avcodec_open2(decoder, codec, nullptr) >= 0, "decoder open failed");
    for (const auto& encoded : {initial, refined}) {
      require(av_new_packet(packet, int(encoded.annex_b.size())) >= 0, "packet allocation failed");
      std::copy(encoded.annex_b.begin(), encoded.annex_b.end(), packet->data);
      require(avcodec_send_packet(decoder, packet) >= 0, "decoder rejected zero-copy frame");
      require(avcodec_receive_frame(decoder, frame) >= 0, "decoder did not return zero-copy frame");
      av_packet_unref(packet);
    }
    const int luma = frame->data[0][size_t(frame->height / 2) * frame->linesize[0] + frame->width / 2];
    require(std::abs(luma - 126) <= 10, "zero-copy refinement decoded to wrong luminance");
  } catch (...) {
    av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&decoder); throw;
  }
  av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&decoder);
}
#endif
class BufferedDamageSource final : public relay::CaptureSource {
  std::shared_ptr<SourceState> state;
  int width, height;
  std::vector<uint8_t> frame;
  std::atomic<bool> buffered_dirty{false};
 public:
  BufferedDamageSource(std::shared_ptr<SourceState> s, int w, int h)
      : state(std::move(s)), width(w), height(h), frame(size_t(w) * h * 4) {}
  relay::WaitHandle fd() const override { return state->wake.handle(); }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  bool drainDamage() override {
    state->wake.consume();
    return buffered_dirty.exchange(false);
  }
  relay::PixelFormat pixelFormat() const override { return relay::PixelFormat::BGRA; }
  relay::FrameView capture() override {
    const unsigned count = ++state->captures;
    const bool red = count > 1;
    for (size_t i = 0; i < frame.size(); i += 4) {
      frame[i] = red ? 48 : 96;
      frame[i + 1] = red ? 64 : 176;
      frame[i + 2] = red ? 192 : 32;
      frame[i + 3] = 255;
    }
    if (count == 1) buffered_dirty.store(true);
    return {frame.data(), width * 4, width, height, relay::PixelFormat::BGRA};
  }
};
static void bufferedDamageDrainedWithoutWake() {
  auto state = std::make_shared<SourceState>(); Frames frames;
  relay::CaptureEncoder encoder([&](std::shared_ptr<const relay::EncodedFrame> f) { return frames.publish(std::move(f)); },
      capture_settings, [state] { return std::make_unique<BufferedDamageSource>(state, 640, 360); });
  std::string error; require(encoder.start(error), error.c_str());
  encoder.beginSession(23);
  encoder.setFlowControl(23, 2, 8000000, false, 0);
  const auto first = frames.at(0);
  require(first.generation == 23 && first.sequence == 1 && first.keyframe, "initial frame missing");
  const auto second = frames.at(1);
  require(second.generation == 23 && second.sequence == 2 && !second.keyframe,
          "buffered damage frame was not encoded without fd wake");
  require(state->captures >= 2, "buffered damage did not trigger a second capture");
  encoder.stop();
}
int main() {
  try {
    healthySource(); runtimeSize(1920, 1080); runtimeSize(1366, 768); runtimeSize(3840, 2160);
    runtimeSize(1280, 720, 120);
    fullScreenDamage(1920, 1080); fullScreenDamage(1366, 768);
    identicalDamageRefines(); invalidSource(1); invalidSource(2);
    bufferedDamageDrainedWithoutWake();
#ifdef __APPLE__
    zeroCopyRefinementPreservesImage();
#endif
    std::puts("backend source: decoded fresh IDRs, damage, refinement, idle, shutdown and invalid frames passed");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "backend source: %s\n", error.what()); return 1;
  }
}
