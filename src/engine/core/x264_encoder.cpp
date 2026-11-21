#include "encoder.hpp"
#include "cpu-budget.hpp"
#include "flow.hpp"
#include <x264.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <deque>
#include <stdexcept>

namespace relay {
namespace {
constexpr float encoder_crf = 10;

constexpr int vbvBufferKbit(uint64_t bitrate, unsigned fps, bool wide) {
  const uint64_t safe_fps = fps ? fps : 1u;
  const uint64_t motion = 4 * bitrate / (1000ull * safe_fps);
  const uint64_t legacy_wide = 8 * bitrate / (1000ull * safe_fps);
  return int(std::max<uint64_t>(1, wide ? std::max(motion, legacy_wide) : motion));
}

static_assert(vbvBufferKbit(1000000, 10, false) == 400);
static_assert(vbvBufferKbit(1000000, 30, false) == 133);
static_assert(vbvBufferKbit(1000000, 60, false) == 66);
static_assert(vbvBufferKbit(250000, 60, false) == 16);
static_assert(vbvBufferKbit(1000000, 10, true) == 800);
static_assert(vbvBufferKbit(1000000, 30, true) == 266);
static_assert(vbvBufferKbit(250000, 60, true) == 33);
static_assert(vbvBufferKbit(1000000, 120, false) == 33);
static_assert(vbvBufferKbit(1000000, 120, true) == 66);
static_assert(vbvBufferKbit(62500, 120, false) == 2);
static_assert(vbvBufferKbit(62500, 120, true) == 4);

/** Synchronous CPU x264 encoder configured for zero-latency Constrained Baseline Annex B output. */
class X264Encoder final : public VideoEncoder {
 public:
  explicit X264Encoder(const EncoderConfig& config)
      : config_(config), threads_(encoderThreads(config.height)), bitrate_(config.bitrate_bps) {}

  ~X264Encoder() override {
    if (codec_) x264_encoder_close(codec_);
    if (frame_allocated_) x264_picture_clean(&frame_);
  }

  bool init(std::string& error) {
    if (!openCodec(error)) return false;
    if (x264_picture_alloc(&frame_, X264_CSP_NV12, config_.width, config_.height) != 0) {
      error = "allocating YUV buffer failed";
      return false;
    }
    frame_allocated_ = true;
    std::memset(frame_.img.plane[0], 16, size_t(frame_.img.i_stride[0]) * size_t(config_.height));
    std::memset(frame_.img.plane[1], 128, size_t(frame_.img.i_stride[1]) * size_t(config_.height / 2));
    return true;
  }

  const std::string& name() const override { return name_; }
  bool hardware() const override { return false; }
  TransferTier transferTier() const override { return TransferTier::software; }
  EncoderInput inputFormat() const override { return EncoderInput::nv12; }
  unsigned maxInflight() const override { return 1; }
  unsigned inflight() const override { return unsigned(ready_.size()); }

  EncoderPlanes planes() override {
    return {{frame_.img.plane[0], frame_.img.plane[1]}, {frame_.img.i_stride[0], frame_.img.i_stride[1]}};
  }

  bool submit(const EncodeRequest& req, std::string& error) override {
    if (!codec_) {
      error = "x264 encoder is not open";
      return false;
    }
    using Clock = std::chrono::steady_clock;
    const auto start = Clock::now();
    const unsigned fps = std::max(1u, config_.fps);
    const uint64_t rate = req.bitrate_bps ? req.bitrate_bps : bitrate_;
    const bool wide_vbv = req.refinement || req.force_idr;
    if (rate != bitrate_ || wide_vbv != wide_vbv_) {
      x264_param_t params;
      x264_encoder_parameters(codec_, &params);
      params.rc.i_vbv_max_bitrate = int(rate / 1000);
      params.rc.i_vbv_buffer_size = vbvBufferKbit(rate, fps, wide_vbv);
      if (x264_encoder_reconfig(codec_, &params) != 0) {
        error = "x264 reconfiguration failed";
        return false;
      }
      bitrate_ = rate;
      wide_vbv_ = wide_vbv;
    }
    frame_.i_pts = req.pts_us;
    frame_.i_type = req.force_idr ? X264_TYPE_IDR : X264_TYPE_AUTO;
    frame_.prop.mb_info = nullptr;
    frame_.prop.mb_info_free = nullptr;
    if (!req.refinement && !req.force_idr && req.mb_info) {
      frame_.prop.mb_info = const_cast<uint8_t*>(req.mb_info);
    }
    x264_nal_t* nals = nullptr;
    int nal_count = 0;
    x264_picture_t picture{};
    const int size = x264_encoder_encode(codec_, &nals, &nal_count, &frame_, &picture);
    const uint64_t elapsed_ns = uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - start).count());
    EncodeResult res;
    res.pts_us = req.pts_us;
    res.tag = req.tag;
    res.encode_ns = elapsed_ns;
    if (size <= 0 || nal_count <= 0 || !nals || picture.i_pts != req.pts_us ||
        size_t(size) > FlowControl::max_bytes) {
      res.status = EncodeStatus::failed;
      res.error = "invalid or delayed x264 access unit";
      ready_.push_back(std::move(res));
      return true;
    }
    res.status = EncodeStatus::encoded;
    res.keyframe = picture.b_keyframe != 0;
    res.converged = req.refinement && picture.prop.f_crf_avg <= encoder_crf + 1 &&
                    uint64_t(size) <= rate / (4ull * fps);
    res.annex_b.assign(nals[0].p_payload, nals[0].p_payload + size);
    ready_.push_back(std::move(res));
    return true;
  }

  bool poll(std::vector<EncodeResult>& out, bool) override {
    if (ready_.empty()) return false;
    while (!ready_.empty()) {
      out.push_back(std::move(ready_.front()));
      ready_.pop_front();
    }
    return true;
  }

  void flush(std::vector<EncodeResult>& out) override { poll(out, false); }

  bool reset(std::string& error) override {
    ready_.clear();
    return openCodec(error);
  }

 private:
  bool openCodec(std::string& error) {
    if (codec_) {
      x264_encoder_close(codec_);
      codec_ = nullptr;
    }
    x264_param_t params;
    if (x264_param_default_preset(&params, "ultrafast", "zerolatency") < 0) {
      error = "setting x264 options failed";
      return false;
    }
    params.i_width = config_.width;
    params.i_height = config_.height;
    params.i_csp = X264_CSP_NV12;
    params.i_timebase_num = 1;
    params.i_timebase_den = 1000000;
    params.i_fps_num = int(config_.fps);
    params.i_fps_den = 1;
    params.i_threads = threads_;
    params.b_sliced_threads = 1;
    params.i_keyint_max = X264_KEYINT_MAX_INFINITE;
    params.i_bframe = 0;
    params.i_scenecut_threshold = 0;
    params.i_sync_lookahead = 0;
    params.rc.i_rc_method = X264_RC_CRF;
    params.rc.f_rf_constant = encoder_crf;
    params.rc.i_lookahead = 0;
    params.rc.i_vbv_max_bitrate = int(config_.bitrate_bps / 1000);
    params.rc.i_vbv_buffer_size = vbvBufferKbit(config_.bitrate_bps, config_.fps, true);
    params.analyse.b_mb_info = 1;
    params.analyse.b_mb_info_update = 0;
    params.b_annexb = 1;
    params.b_repeat_headers = 1;
    params.vui.b_fullrange = 0;
    params.vui.i_colmatrix = 1;
    params.vui.i_colorprim = 1;
    params.vui.i_transfer = 1;
    params.vui.i_chroma_loc = 1;
    codec_ = x264_encoder_open(&params);
    if (!codec_) {
      error = "opening x264 encoder failed";
      return false;
    }
    bitrate_ = config_.bitrate_bps;
    wide_vbv_ = true;
    return true;
  }

  std::string name_ = "x264";
  EncoderConfig config_;
  int threads_;
  x264_t* codec_ = nullptr;
  x264_picture_t frame_{};
  bool frame_allocated_ = false;
  uint64_t bitrate_;
  bool wide_vbv_ = true;
  std::deque<EncodeResult> ready_;
};
}  // namespace

std::unique_ptr<VideoEncoder> createX264Encoder(const EncoderConfig& config, std::string& error) {
  auto enc = std::make_unique<X264Encoder>(config);
  if (!enc->init(error)) return nullptr;
  return enc;
}

}  // namespace relay
