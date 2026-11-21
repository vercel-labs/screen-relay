#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace relay {

struct DamageRect;

/** Pixel or surface input format expected by a VideoEncoder implementation. */
enum class EncoderInput : uint8_t { nv12, bgra, native_handle };

enum class TransferTier : uint8_t { zero_copy, dirty_upload, full_upload, software };

const char* transferTierName(TransferTier tier);

bool hardwareEncoderCoolingDown(const std::string& key);

/** Per-frame encode outcome distinguishing rate-control drops from fatal encoder errors. */
enum class EncodeStatus : uint8_t { encoded, dropped, failed };

/** Explicit lifecycle states of EncoderController. */
enum class EncoderState : uint8_t {
  uninitialized,
  probing,
  hardware_active,
  hardware_degraded,
  software_active,
  failed,
};

/** Returns a stable lowercase name for an EncoderState value. */
const char* encoderStateName(EncoderState state);

/** Writable plane pointers valid for the upcoming submit() call. */
struct EncoderPlanes {
  uint8_t* data[2] = {};
  int stride[2] = {};
};

/** Parameters for one frame submission to a VideoEncoder. */
struct EncodeRequest {
  int64_t pts_us = 0;
  uint64_t tag = 0;
  bool force_idr = false;
  bool refinement = false;
  uint64_t bitrate_bps = 0;
  const uint8_t* mb_info = nullptr;
  void* native_handle = nullptr;
  const std::vector<DamageRect>* damage = nullptr;
};

/** Completed output produced by a VideoEncoder for one submitted frame. */
struct EncodeResult {
  EncodeStatus status = EncodeStatus::failed;
  int64_t pts_us = 0;
  uint64_t tag = 0;
  bool keyframe = false;
  bool converged = false;
  uint64_t encode_ns = 0;
  std::vector<uint8_t> annex_b;
  std::string error;
};

/** Parameters shared across all H.264 encoder backends. */
struct EncoderConfig {
  std::string preference = "auto";
  int width = 0;
  int height = 0;
  unsigned fps = 60;
  uint64_t bitrate_bps = 8000000;
  bool source_bgra = true;
};

/** Callback invoked when an asynchronous encoder finishes a frame. */
using EncoderReadyCallback = std::function<void()>;

/** Polymorphic H.264 encoder emitting Annex B access units synchronously or with bounded pipelining. */
class VideoEncoder {
 public:
  virtual ~VideoEncoder() = default;
  virtual const std::string& name() const = 0;
  virtual bool hardware() const = 0;
  virtual TransferTier transferTier() const { return hardware() ? TransferTier::full_upload : TransferTier::software; }
  virtual EncoderInput inputFormat() const = 0;
  /** Maximum number of frames accepted before waiting for completed output. */
  virtual unsigned maxInflight() const { return 1; }
  /** Number of submitted frames currently awaiting completion. */
  virtual unsigned inflight() const { return 0; }
  /** Writable input plane pointers; callers must query this fresh before writing each frame. */
  virtual EncoderPlanes planes() = 0;
  /** Submits one prepared frame or native handle; synchronous encoders complete before returning. */
  virtual bool submit(const EncodeRequest& req, std::string& error) = 0;
  /** Drains completed frames; when wait is true, blocks until at least one completes or none remain. */
  virtual bool poll(std::vector<EncodeResult>& out, bool wait) = 0;
  /** Waits for all in-flight frames to finish and appends them to out in submission order. */
  virtual void flush(std::vector<EncodeResult>& out) = 0;
  /** Resets codec state after a transient failure or session boundary. */
  virtual bool reset(std::string& error) = 0;
};

/** Returns true if an Annex B byte stream contains at least one NAL unit of the given 5-bit type. */
bool hasNalUnit(const std::vector<uint8_t>& annex_b, uint8_t nal_type);

/** Extracts the 6-hex-character H.264 profile-level-id from an SPS NAL in annex_b, or empty if absent. */
std::string extractProfileLevelId(const std::vector<uint8_t>& annex_b);

/** Action CaptureEncoder should take after EncoderController evaluates one EncodeResult. */
enum class EncoderAction : uint8_t { publish, drop, recover_idr, fatal };

/** Decision returned by EncoderController::evaluate(). */
struct EncoderDecision {
  EncoderAction action = EncoderAction::fatal;
  bool switched_to_software = false;
  std::string message;
};

/** Factory hooks enabling deterministic unit testing of EncoderController transitions. */
struct EncoderFactories {
  using Factory = std::function<std::unique_ptr<VideoEncoder>(const EncoderConfig&, EncoderReadyCallback, std::string&)>;
  Factory hardware;
  Factory software;
};

/** Explicit state machine owning hardware probing, drop tolerance, transient recovery, and software fallback. */
class EncoderController {
 public:
  static constexpr unsigned max_consecutive_drops = 15;
  static constexpr unsigned max_software_failures = 3;
  static constexpr std::chrono::seconds hardware_cooldown{30};
  static constexpr unsigned budget_window_frames = 30;
  static constexpr unsigned budget_miss_threshold = 24;
  static constexpr unsigned recovery_healthy_streak = 120;

  explicit EncoderController(EncoderFactories factories = {});

  /** Probes hardware (unless preference is "x264") and opens a verified encoder; throws on total failure. */
  void open(const EncoderConfig& config, EncoderReadyCallback on_ready);

  /** Evaluates one completed EncodeResult and executes any state transition in one place. */
  EncoderDecision evaluate(const EncodeResult& result, bool forced_idr);

  /** Handles a submit() failure through the same state machine as a failed EncodeResult. */
  EncoderDecision onSubmitFailure(const std::string& error, bool forced_idr);

  /** Resets encoder state after a non-encoder capture error. */
  void resetForCaptureError();

  /** Clears process-wide hardware cooldowns; intended for tests. */
  static void clearCooldowns();

  VideoEncoder& active() { return *encoder_; }
  const VideoEncoder& active() const { return *encoder_; }
  EncoderState state() const { return state_; }
  const std::string& name() const { return encoder_ ? encoder_->name() : empty_; }
  bool hardware() const { return encoder_ && encoder_->hardware(); }
  TransferTier transferTier() const { return encoder_ ? encoder_->transferTier() : TransferTier::software; }
  EncoderInput inputFormat() const { return encoder_ ? encoder_->inputFormat() : EncoderInput::nv12; }
  const std::string& profileLevelId() const { return profile_level_id_; }
  uint64_t droppedFrames() const { return dropped_frames_; }
  uint64_t fallbackCount() const { return fallback_count_; }

 private:
  bool probeEncoder(VideoEncoder& encoder, std::string& reason);
  bool switchToSoftware(std::string& error);
  EncoderDecision fallBackFromHardware(const std::string& reason, EncoderAction on_success);
  EncoderDecision handleHardwareFailure(const std::string& reason);
  EncoderDecision publishHardwareFrame(uint64_t encode_ns);

  EncoderFactories factories_;
  EncoderConfig config_{};
  EncoderReadyCallback on_ready_;
  std::unique_ptr<VideoEncoder> encoder_;
  EncoderState state_ = EncoderState::uninitialized;
  std::string profile_level_id_;
  std::string empty_;
  unsigned consecutive_drops_ = 0;
  unsigned consecutive_sw_failures_ = 0;
  bool hw_recovered_once_ = false;
  unsigned healthy_hw_frames_ = 0;
  std::array<bool, budget_window_frames> budget_misses_{};
  unsigned budget_count_ = 0;
  unsigned budget_index_ = 0;
  unsigned budget_miss_total_ = 0;
  uint64_t dropped_frames_ = 0;
  uint64_t fallback_count_ = 0;
};

/** Default software x264 encoder factory. */
std::unique_ptr<VideoEncoder> createX264Encoder(const EncoderConfig& config, std::string& error);

/** Default platform hardware encoder factory (VideoToolbox on macOS, libavcodec NVENC/VAAPI/QSV/AMF elsewhere). */
std::unique_ptr<VideoEncoder> createHardwareEncoder(const EncoderConfig& config, EncoderReadyCallback on_ready, std::string& error);

#ifdef __APPLE__
/** Native Apple VideoToolbox hardware H.264 encoder with zero-copy CVPixelBuffer support and shallow pipelining. */
std::unique_ptr<VideoEncoder> createVideoToolboxEncoder(const EncoderConfig& config, EncoderReadyCallback on_ready, std::string& error);
#endif

#ifdef RELAY_HWENC
/** Portable libavcodec hardware H.264 encoder factory for NVENC, VAAPI, QSV, AMF, or an explicit codec name. */
std::unique_ptr<VideoEncoder> createLibavEncoder(const EncoderConfig& config, EncoderReadyCallback on_ready, std::string& error);
#endif

}  // namespace relay
