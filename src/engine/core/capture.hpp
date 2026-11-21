#pragma once

#include "capture-source.hpp"
#include "encoder.hpp"
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace relay {

/** Immutable encoded H.264 Annex B frame shared across all active viewers without copying bytes. */
struct EncodedFrame {
  uint32_t generation = 0;
  uint32_t sequence = 0;
  int64_t pts_us = 0;
  uint16_t width = 0;
  uint16_t height = 0;
  bool keyframe = false;
  std::vector<uint8_t> annex_b;
};

/** Runtime counters and active encoder metadata exposed by CaptureEncoder. */
struct CaptureStats {
  bool cursor_supported = false;
  bool hardware_encoder = false;
  TransferTier transfer_tier = TransferTier::software;
  std::string encoder;
  std::string encoder_state;
  std::string profile_level_id;
  uint64_t captures = 0;
  uint64_t encoded = 0;
  uint64_t dropped_frames = 0;
  uint64_t fallback_count = 0;
  uint64_t capture_ns = 0;
  uint64_t convert_ns = 0;
  uint64_t encode_ns = 0;
};

struct CaptureSettings {
  unsigned fps = 60;
  uint64_t min_bitrate = 1000000;
  uint64_t start_bitrate = 8000000;
  uint64_t max_bitrate = 40000000;
  std::string encoder = "auto";
};

/** Runs screen capture and H.264 encoding on a worker thread, publishing immutable frames to a callback. */
class CaptureEncoder {
 public:
  using Publish = std::function<bool(std::shared_ptr<const EncodedFrame>)>;
  using PublishCursor = std::function<void(uint32_t, CursorImage&&)>;

  CaptureEncoder(Publish publish, CaptureSettings settings, CaptureSourceFactory factory,
                 PublishCursor publish_cursor = {}, EncoderFactories encoder_factories = {});
  ~CaptureEncoder();
  CaptureEncoder(const CaptureEncoder&) = delete;
  CaptureEncoder& operator=(const CaptureEncoder&) = delete;

  bool start(std::string& error);
  void beginSession(uint32_t generation);
  void endSession(uint32_t generation);
  void acknowledge(uint32_t generation, uint32_t sequence);
  void setFlowControl(uint32_t generation, unsigned window, uint64_t bitrate, bool paused, uint64_t admit_until_us);
  /** Forces the next encoded frame to be an IDR and republishes the cursor for a joining or recovering viewer. */
  void requestKeyframe();
  CaptureStats stats() const;
  std::string error() const;
  void stop();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace relay
