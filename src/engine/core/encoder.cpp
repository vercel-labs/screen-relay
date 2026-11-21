#include "encoder.hpp"
#include <algorithm>
#include <cstdio>
#include <map>
#include <mutex>
#include <stdexcept>

namespace relay {
namespace {
std::mutex cooldown_mutex;
std::map<std::string, std::chrono::steady_clock::time_point> candidate_cooldowns;

void markCooldown(const std::string& key, std::chrono::steady_clock::time_point until) {
  std::lock_guard<std::mutex> lock(cooldown_mutex);
  candidate_cooldowns[key] = until;
}
}  // namespace

const char* encoderStateName(EncoderState state) {
  switch (state) {
    case EncoderState::uninitialized: return "uninitialized";
    case EncoderState::probing: return "probing";
    case EncoderState::hardware_active: return "hardware_active";
    case EncoderState::hardware_degraded: return "hardware_degraded";
    case EncoderState::software_active: return "software_active";
    case EncoderState::failed: return "failed";
  }
  return "unknown";
}

bool hardwareEncoderCoolingDown(const std::string& key) {
  std::lock_guard<std::mutex> lock(cooldown_mutex);
  const auto it = candidate_cooldowns.find(key);
  if (it == candidate_cooldowns.end()) return false;
  if (std::chrono::steady_clock::now() >= it->second) {
    candidate_cooldowns.erase(it);
    return false;
  }
  return true;
}

const char* transferTierName(TransferTier tier) {
  switch (tier) {
    case TransferTier::zero_copy: return "zero_copy";
    case TransferTier::dirty_upload: return "dirty_upload";
    case TransferTier::full_upload: return "full_upload";
    case TransferTier::software: return "software";
  }
  return "unknown";
}

bool hasNalUnit(const std::vector<uint8_t>& annex_b, uint8_t nal_type) {
  for (size_t i = 0; i + 3 < annex_b.size(); ++i) {
    if (annex_b[i] == 0 && annex_b[i + 1] == 0 && annex_b[i + 2] == 1 &&
        (annex_b[i + 3] & 31) == nal_type) {
      return true;
    }
  }
  return false;
}

std::string extractProfileLevelId(const std::vector<uint8_t>& annex_b) {
  for (size_t i = 0; i + 6 < annex_b.size(); ++i) {
    if (annex_b[i] == 0 && annex_b[i + 1] == 0 && annex_b[i + 2] == 1 &&
        (annex_b[i + 3] & 31) == 7) {
      char hex[7];
      std::snprintf(hex, sizeof(hex), "%02x%02x%02x", annex_b[i + 4], annex_b[i + 5], annex_b[i + 6]);
      return hex;
    }
  }
  return {};
}

std::unique_ptr<VideoEncoder> createHardwareEncoder(const EncoderConfig& config, EncoderReadyCallback on_ready, std::string& error) {
#ifdef __APPLE__
  if (config.preference == "auto" || config.preference == "videotoolbox" || config.preference == "h264_videotoolbox") {
    if (config.preference != "auto" || !hardwareEncoderCoolingDown("videotoolbox")) {
      std::string vt_error;
      if (auto vt = createVideoToolboxEncoder(config, on_ready, vt_error)) return vt;
      error = vt_error;
      if (config.preference == "videotoolbox") return nullptr;
    } else {
      error = "videotoolbox in cooldown";
    }
  }
#endif
#ifdef RELAY_HWENC
  if (config.preference != "videotoolbox") {
    if (config.preference != "auto" || !hardwareEncoderCoolingDown("libav:auto")) {
      std::string av_error;
      if (auto av = createLibavEncoder(config, on_ready, av_error)) return av;
      if (!av_error.empty()) error = av_error;
    } else if (error.empty()) {
      error = "libav hardware encoder in cooldown";
    }
  }
#elif !defined(__APPLE__)
  (void)config;
  (void)on_ready;
#endif
  if (error.empty()) error = "no hardware encoder available";
  return nullptr;
}

EncoderController::EncoderController(EncoderFactories factories) : factories_(std::move(factories)) {
  if (!factories_.hardware) factories_.hardware = createHardwareEncoder;
  if (!factories_.software) {
    factories_.software = [](const EncoderConfig& cfg, EncoderReadyCallback, std::string& err) {
      return createX264Encoder(cfg, err);
    };
  }
}

void EncoderController::clearCooldowns() {
  std::lock_guard<std::mutex> lock(cooldown_mutex);
  candidate_cooldowns.clear();
}

bool EncoderController::probeEncoder(VideoEncoder& encoder, std::string& reason) {
  EncodeRequest req;
  req.pts_us = 0;
  req.tag = 0;
  req.force_idr = true;
  req.bitrate_bps = config_.bitrate_bps;
  std::string submit_error;
  if (!encoder.submit(req, submit_error)) {
    reason = submit_error.empty() ? "probe submit failed" : submit_error;
    return false;
  }
  std::vector<EncodeResult> results;
  encoder.flush(results);
  if (results.empty()) {
    reason = "probe returned no frame";
    return false;
  }
  const auto& first = results.front();
  if (first.status != EncodeStatus::encoded) {
    reason = first.error.empty() ? "probe did not encode IDR" : first.error;
    return false;
  }
  if (!first.keyframe || !hasNalUnit(first.annex_b, 5) || !hasNalUnit(first.annex_b, 7) || !hasNalUnit(first.annex_b, 8)) {
    reason = "probe output omitted Annex B IDR/SPS/PPS";
    return false;
  }
  profile_level_id_ = extractProfileLevelId(first.annex_b);
  std::string reset_error;
  if (!encoder.reset(reset_error)) {
    reason = reset_error.empty() ? "probe reset failed" : reset_error;
    return false;
  }
  return true;
}

bool EncoderController::switchToSoftware(std::string& error) {
  std::unique_ptr<VideoEncoder> sw = factories_.software(config_, on_ready_, error);
  if (!sw) {
    state_ = EncoderState::failed;
    encoder_.reset();
    return false;
  }
  encoder_ = std::move(sw);
  state_ = EncoderState::software_active;
  consecutive_drops_ = 0;
  consecutive_sw_failures_ = 0;
  if (profile_level_id_.empty()) profile_level_id_ = "42c01f";
  std::fprintf(stderr, "encoder: %s\n", encoder_->name().c_str());
  return true;
}

void EncoderController::open(const EncoderConfig& config, EncoderReadyCallback on_ready) {
  config_ = config;
  on_ready_ = std::move(on_ready);
  encoder_.reset();
  profile_level_id_.clear();
  consecutive_drops_ = 0;
  consecutive_sw_failures_ = 0;
  hw_recovered_once_ = false;
  healthy_hw_frames_ = 0;
  budget_misses_.fill(false);
  budget_count_ = 0;
  budget_index_ = 0;
  budget_miss_total_ = 0;

  if (config_.preference != "x264") {
    state_ = EncoderState::probing;
    std::string hw_error;
    auto hw = factories_.hardware(config_, on_ready_, hw_error);
    if (hw) {
      std::string probe_error;
      if (probeEncoder(*hw, probe_error)) {
        encoder_ = std::move(hw);
        state_ = EncoderState::hardware_active;
        const char* fmt = encoder_->inputFormat() == EncoderInput::native_handle ? "native"
                        : encoder_->inputFormat() == EncoderInput::bgra ? "BGRA" : "NV12";
        std::fprintf(stderr, "encoder: %s (%s input, inflight=%u)\n",
                     encoder_->name().c_str(), fmt, encoder_->maxInflight());
        return;
      }
      std::fprintf(stderr, "encoder %s failed probe: %s\n", hw->name().c_str(), probe_error.c_str());
      const auto until = std::chrono::steady_clock::now() + hardware_cooldown;
      markCooldown(hw->name(), until);
      if (config_.preference == "auto" && hw->name() != "videotoolbox") {
        markCooldown("libav:auto", until);
      }
    } else if (!hw_error.empty()) {
      std::fprintf(stderr, "hardware encoder unavailable: %s\n", hw_error.c_str());
    }
  }

  std::string sw_error;
  if (!switchToSoftware(sw_error)) {
    throw std::runtime_error(sw_error.empty() ? "opening software x264 encoder failed" : sw_error);
  }
}

EncoderDecision EncoderController::fallBackFromHardware(const std::string& reason, EncoderAction on_success) {
  const std::string failed_name = encoder_ ? encoder_->name() : "hardware";
  state_ = EncoderState::hardware_degraded;
  markCooldown(failed_name, std::chrono::steady_clock::now() + hardware_cooldown);
  ++fallback_count_;
  std::fprintf(stderr, "capture: %s: %s; switching to x264\n", failed_name.c_str(), reason.c_str());
  std::string sw_error;
  if (!switchToSoftware(sw_error)) {
    return {EncoderAction::fatal, false, sw_error.empty() ? reason : sw_error};
  }
  return {on_success, true, reason};
}

EncoderDecision EncoderController::handleHardwareFailure(const std::string& reason) {
  healthy_hw_frames_ = 0;
  const std::string failed_name = encoder_ ? encoder_->name() : "hardware";
  if (state_ == EncoderState::hardware_active && !hw_recovered_once_ && encoder_) {
    state_ = EncoderState::hardware_degraded;
    hw_recovered_once_ = true;
    consecutive_drops_ = 0;
    std::string reset_error;
    if (encoder_->reset(reset_error)) {
      state_ = EncoderState::hardware_active;
      std::fprintf(stderr, "capture: %s transient failure (%s); reset succeeded, retrying with IDR\n",
                   failed_name.c_str(), reason.c_str());
      return {EncoderAction::recover_idr, false, reason};
    }
  }

  markCooldown("libav:auto", std::chrono::steady_clock::now() + hardware_cooldown);
  return fallBackFromHardware(reason, EncoderAction::recover_idr);
}

EncoderDecision EncoderController::publishHardwareFrame(uint64_t encode_ns) {
  const uint64_t frame_budget_ns = (1000000000ull * 9) / (10ull * std::max(1u, config_.fps));
  const bool missed = encode_ns > frame_budget_ns;
  if (missed) {
    healthy_hw_frames_ = 0;
  } else if (healthy_hw_frames_ < recovery_healthy_streak) {
    if (++healthy_hw_frames_ >= recovery_healthy_streak) hw_recovered_once_ = false;
  }

  if (budget_count_ < budget_window_frames) {
    ++budget_count_;
  } else {
    budget_miss_total_ -= budget_misses_[budget_index_];
  }
  budget_misses_[budget_index_] = missed;
  budget_miss_total_ += missed;
  budget_index_ = (budget_index_ + 1) % budget_window_frames;

  if (config_.preference == "auto" && budget_count_ >= budget_window_frames &&
      budget_miss_total_ >= budget_miss_threshold) {
    const auto reason = "encode time exceeded the frame budget on " + std::to_string(budget_miss_total_) +
                        " of the last " + std::to_string(budget_window_frames) + " frames";
    return fallBackFromHardware(reason, EncoderAction::publish);
  }
  return {EncoderAction::publish, false, {}};
}

EncoderDecision EncoderController::evaluate(const EncodeResult& result, bool forced_idr) {
  switch (state_) {
    case EncoderState::hardware_active: {
      if (result.status == EncodeStatus::encoded) {
        if (forced_idr && (!result.keyframe || !hasNalUnit(result.annex_b, 5) ||
                           !hasNalUnit(result.annex_b, 7) || !hasNalUnit(result.annex_b, 8))) {
          return handleHardwareFailure("hardware encoder omitted IDR/SPS/PPS");
        }
        if (result.keyframe) {
          const auto plid = extractProfileLevelId(result.annex_b);
          if (!plid.empty()) profile_level_id_ = plid;
        }
        consecutive_drops_ = 0;
        return publishHardwareFrame(result.encode_ns);
      }
      if (result.status == EncodeStatus::dropped) {
        healthy_hw_frames_ = 0;
        ++dropped_frames_;
        if (forced_idr) {
          return handleHardwareFailure("hardware encoder dropped forced IDR");
        }
        ++consecutive_drops_;
        if (consecutive_drops_ >= max_consecutive_drops) {
          return handleHardwareFailure("hardware encoder dropped too many consecutive frames");
        }
        return {EncoderAction::drop, false, {}};
      }
      return handleHardwareFailure(result.error.empty() ? "hardware encode failed" : result.error);
    }
    case EncoderState::software_active: {
      if (result.status == EncodeStatus::encoded) {
        if (forced_idr && (!result.keyframe || !hasNalUnit(result.annex_b, 5) ||
                           !hasNalUnit(result.annex_b, 7) || !hasNalUnit(result.annex_b, 8))) {
          ++consecutive_sw_failures_;
          if (consecutive_sw_failures_ >= max_software_failures) {
            state_ = EncoderState::failed;
            return {EncoderAction::fatal, false, "software encoder omitted IDR/SPS/PPS"};
          }
          std::string err;
          if (!encoder_->reset(err)) {
            state_ = EncoderState::failed;
            return {EncoderAction::fatal, false, err.empty() ? "software encoder reset failed" : err};
          }
          return {EncoderAction::recover_idr, false, "software encoder omitted IDR/SPS/PPS"};
        }
        if (result.keyframe) {
          const auto plid = extractProfileLevelId(result.annex_b);
          if (!plid.empty()) profile_level_id_ = plid;
        }
        consecutive_sw_failures_ = 0;
        return {EncoderAction::publish, false, {}};
      }
      if (result.status == EncodeStatus::dropped && !forced_idr) {
        ++dropped_frames_;
        return {EncoderAction::drop, false, {}};
      }
      ++consecutive_sw_failures_;
      const std::string reason = result.error.empty() ? "software encode failed" : result.error;
      if (consecutive_sw_failures_ >= max_software_failures) {
        state_ = EncoderState::failed;
        return {EncoderAction::fatal, false, reason};
      }
      std::string err;
      if (!encoder_->reset(err)) {
        state_ = EncoderState::failed;
        return {EncoderAction::fatal, false, err.empty() ? "software encoder reset failed" : err};
      }
      return {EncoderAction::recover_idr, false, reason};
    }
    case EncoderState::uninitialized:
    case EncoderState::probing:
    case EncoderState::hardware_degraded:
    case EncoderState::failed:
      state_ = EncoderState::failed;
      return {EncoderAction::fatal, false, result.error.empty() ? "encoder not active" : result.error};
  }
  state_ = EncoderState::failed;
  return {EncoderAction::fatal, false, "invalid encoder state"};
}

EncoderDecision EncoderController::onSubmitFailure(const std::string& error, bool forced_idr) {
  EncodeResult failed;
  failed.status = EncodeStatus::failed;
  failed.error = error;
  return evaluate(failed, forced_idr);
}

void EncoderController::resetForCaptureError() {
  if (!encoder_) return;
  std::string err;
  if (state_ == EncoderState::software_active && !encoder_->reset(err)) {
    state_ = EncoderState::failed;
  }
}

}  // namespace relay
