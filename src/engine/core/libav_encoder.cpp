#ifdef RELAY_HWENC
#include "encoder.hpp"
#include "flow.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libavutil/version.h>
}

#include <algorithm>
#include <array>
#include <chrono>
#include <climits>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace relay {
namespace {
struct Candidate {
  const char* name;
  AVHWDeviceType upload;
  bool dynamic_bitrate;
  const char* options;
  const char* fallback;
};

/** Platform hardware H.264 encoders probed in priority order for low-latency streaming. */
constexpr Candidate candidates[] = {
#if defined(__APPLE__)
  {"h264_videotoolbox", AV_HWDEVICE_TYPE_NONE, false, "realtime=1:prio_speed=1:allow_sw=0", nullptr},
#else
  {"h264_nvenc", AV_HWDEVICE_TYPE_NONE, true, "preset=p4:tune=ll:rc=vbr:spatial-aq=1:aq-strength=8:delay=0:zerolatency=1:forced-idr=1", "preset=p1:tune=ll:rc=vbr:delay=0:zerolatency=1:forced-idr=1"},
#if defined(_WIN32)
  {"h264_qsv", AV_HWDEVICE_TYPE_NONE, true, "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1:low_power=1", "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1"},
  {"h264_amf", AV_HWDEVICE_TYPE_NONE, false, "usage=ultralowlatency:rc=cbr:forced_idr=1:latency=1:async_depth=1:frame_skipping=0:filler_data=0", "usage=lowlatency:rc=cbr:forced_idr=1:async_depth=1"},
#else
  {"h264_vaapi", AV_HWDEVICE_TYPE_VAAPI, false, "async_depth=1:rc_mode=CBR:sei=0:low_power=1", "async_depth=1:rc_mode=CBR:sei=0"},
  {"h264_qsv", AV_HWDEVICE_TYPE_NONE, true, "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1:low_power=1", "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1"},
#endif
#endif
};

/** Computes a low-latency VBV buffer size in bits with enough headroom for keyframes at high frame rates. */
int libavVbvBufferBits(uint64_t bitrate, unsigned fps) {
  const uint64_t per_frame_window = 4 * bitrate / std::max(1u, fps);
  const uint64_t half_second = bitrate / 2;
  return int(std::clamp<uint64_t>(std::max(per_frame_window, half_second), 16 * 1024, uint64_t(INT_MAX)));
}

std::string avError(int code) {
  char text[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(code, text, sizeof(text));
  return text;
}

bool codecSupportsPixelFormat(const AVCodec* codec, AVPixelFormat target) {
  if (!codec || target == AV_PIX_FMT_NONE) return false;
#if LIBAVCODEC_VERSION_INT >= AV_VERSION_INT(61, 13, 100)
  const void* list = nullptr;
  int count = 0;
  if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0, &list, &count) >= 0 && list) {
    const auto* formats = static_cast<const AVPixelFormat*>(list);
    for (int i = 0; i < count; ++i) {
      if (formats[i] == target) return true;
    }
    return false;
  }
#endif
#if LIBAVCODEC_VERSION_MAJOR < 62
  if (codec->pix_fmts) {
    for (const AVPixelFormat* p = codec->pix_fmts; *p != AV_PIX_FMT_NONE; ++p) {
      if (*p == target) return true;
    }
    return false;
  }
#endif
  return false;
}

/** Portable libavcodec H.264 encoder for NVENC, VAAPI, QSV, AMF, or an explicit codec name. */
class LibavEncoder final : public VideoEncoder {
 public:
  LibavEncoder(const Candidate* candidate, std::string codec_name, const EncoderConfig& config,
               EncoderReadyCallback on_ready)
      : candidate_(candidate), name_(std::move(codec_name)), config_(config), on_ready_(std::move(on_ready)),
        bitrate_(config.bitrate_bps) {}

  ~LibavEncoder() override {
    stopWorker();
    closeCodec();
    for (AVFrame*& slot : slots_) av_frame_free(&slot);
    av_frame_free(&upload_);
    av_packet_free(&packet_);
    av_buffer_unref(&device_);
  }

  bool init(std::string& error) {
    const AVCodec* codec = avcodec_find_encoder_by_name(name_.c_str());
    if (!codec) {
      error = "not built into libavcodec";
      return false;
    }
    format_ = AV_PIX_FMT_NV12;
    if (allocate() && openWithFallback(error)) return startCodec();
    closeCodec();
    if (config_.source_bgra && codecSupportsPixelFormat(codec, AV_PIX_FMT_BGR0)) {
      format_ = AV_PIX_FMT_BGR0;
      if (allocate() && openWithFallback(error)) return startCodec();
      closeCodec();
    }
    return false;
  }

  const std::string& name() const override { return name_; }
  bool hardware() const override { return true; }
  TransferTier transferTier() const override { return TransferTier::full_upload; }
  EncoderInput inputFormat() const override { return format_ == AV_PIX_FMT_NV12 ? EncoderInput::nv12 : EncoderInput::bgra; }
  unsigned maxInflight() const override { return slot_count; }

  unsigned inflight() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return inflight_;
  }

  EncoderPlanes planes() override {
    std::unique_lock<std::mutex> lock(mutex_);
    if (pending_slot_ < 0) {
      cv_.wait(lock, [this] { return stopping_ || !open_ || freeSlot() >= 0; });
      if (stopping_ || !open_) return {};
      pending_slot_ = chooseSlot();
    }
    return pending_slot_ >= 0 ? slotPlanes(pending_slot_) : EncoderPlanes{};
  }

  bool submit(const EncodeRequest& req, std::string& error) override {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!open_ || stopping_) {
      error = "libav encoder is not open";
      return false;
    }
    int slot = pending_slot_;
    if (slot >= 0) {
      pending_slot_ = -1;
    } else {
      if (req.refinement) {
        cv_.wait(lock, [this] { return stopping_ || !open_ || freeSlot() >= 0; });
        if (stopping_ || !open_) {
          error = "libav encoder is not open";
          return false;
        }
        slot = chooseSlot();
      } else {
        slot = freeSlot();
      }
    }
    if (slot < 0) {
      error = "libav encoder has no free input slot";
      return false;
    }

    Job job;
    job.pts_us = req.pts_us;
    job.tag = req.tag;
    job.force_idr = req.force_idr;
    job.refinement = req.refinement;
    job.bitrate_bps = req.bitrate_bps;
    job.slot = slot;
    job.frame = slots_[slot];
    slot_busy_[slot] = true;
    latest_ = slot;
    ++inflight_;
    jobs_.push_back(job);
    cv_.notify_all();
    return true;
  }

  bool poll(std::vector<EncodeResult>& out, bool wait) override {
    std::unique_lock<std::mutex> lock(mutex_);
    if (wait && ready_.empty() && inflight_ > 0) {
      cv_.wait(lock, [this] { return !ready_.empty() || inflight_ == 0; });
    }
    if (ready_.empty()) return false;
    while (!ready_.empty()) {
      out.push_back(std::move(ready_.front()));
      ready_.pop_front();
    }
    return true;
  }

  void flush(std::vector<EncodeResult>& out) override {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this] { return inflight_ == 0 || stopping_ || !open_; });
    while (!ready_.empty()) {
      out.push_back(std::move(ready_.front()));
      ready_.pop_front();
    }
  }

  bool reset(std::string& error) override {
    stopWorker();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      open_ = false;
      ready_.clear();
      pending_slot_ = -1;
      latest_ = -1;
      slot_busy_.fill(false);
      inflight_ = 0;
    }
    closeCodec();
    if (!openWithFallback(error)) return false;
    return startCodec();
  }

 private:
  static constexpr int slot_count = 2;

  struct Job {
    int64_t pts_us = 0;
    uint64_t tag = 0;
    bool force_idr = false;
    bool refinement = false;
    uint64_t bitrate_bps = 0;
    int slot = 0;
    AVFrame* frame = nullptr;
  };

  bool startCodec() {
    changed_ = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(mutex_);
    open_ = true;
    return startWorker();
  }

  bool startWorker() {
    if (worker_.joinable()) return true;
    stopping_ = false;
    worker_ = std::thread([this] { workerLoop(); });
    return worker_.joinable();
  }

  /** Stops the encode worker and drops any queued jobs; callers must not hold mutex_ or use the codec afterwards. */
  void stopWorker() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
      jobs_.clear();
    }
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();
    std::lock_guard<std::mutex> lock(mutex_);
    if (inflight_ > 0) inflight_ = 0;
  }

  void workerLoop() {
    std::unique_lock<std::mutex> lock(mutex_);
    while (true) {
      cv_.wait(lock, [this] { return stopping_ || !jobs_.empty(); });
      if (stopping_) return;
      const Job job = jobs_.front();
      jobs_.pop_front();
      lock.unlock();

      const auto started = std::chrono::steady_clock::now();
      EncodeResult res = encodeJob(job, started);

      lock.lock();
      slot_busy_[job.slot] = false;
      ready_.push_back(std::move(res));
      if (inflight_ > 0) --inflight_;
      cv_.notify_all();
      lock.unlock();
      if (on_ready_) on_ready_();
      lock.lock();
    }
  }

  /** Encodes one queued frame on the worker thread and returns its completed result. */
  EncodeResult encodeJob(const Job& job, std::chrono::steady_clock::time_point started) {
    using Clock = std::chrono::steady_clock;
    EncodeResult res;
    res.pts_us = job.pts_us;
    res.tag = job.tag;
    const auto finish = [&](EncodeStatus status, std::string message) {
      res.status = status;
      res.error = std::move(message);
      res.encode_ns = uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - started).count());
      return std::move(res);
    };
    if (!context_ || !job.frame) return finish(EncodeStatus::failed, "libav encoder is not open");

    bool idr = job.force_idr;
    const uint64_t rate = job.bitrate_bps ? job.bitrate_bps : bitrate_;
    const auto now = Clock::now();
    const bool large_change = rate * 4 > bitrate_ * 5 || rate * 5 < bitrate_ * 4;
    if (large_change && now - changed_ >= std::chrono::seconds(1)) {
      bitrate_ = rate;
      changed_ = now;
      if (candidate_ && candidate_->dynamic_bitrate) {
        context_->bit_rate = context_->rc_max_rate = int64_t(rate);
        context_->rc_buffer_size = libavVbvBufferBits(rate, config_.fps);
      } else {
        std::string reopen_error;
        if (!openWithFallback(reopen_error)) {
          {
            std::lock_guard<std::mutex> lock(mutex_);
            open_ = false;
          }
          return finish(EncodeStatus::failed, "reopen: " + reopen_error);
        }
        idr = true;
      }
    }

    AVFrame* input = job.frame;
    if (context_->hw_frames_ctx) {
      if (!upload_ && !(upload_ = av_frame_alloc())) return finish(EncodeStatus::failed, "out of memory");
      av_frame_unref(upload_);
      if (const int code = av_hwframe_get_buffer(context_->hw_frames_ctx, upload_, 0)) {
        return finish(EncodeStatus::failed, "hardware frame: " + avError(code));
      }
      if (const int code = av_hwframe_transfer_data(upload_, job.frame, 0)) {
        return finish(EncodeStatus::failed, "upload: " + avError(code));
      }
      input = upload_;
    }

    input->pts = job.pts_us;
    input->pict_type = idr ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
#ifdef AV_FRAME_FLAG_KEY
    if (idr) input->flags |= AV_FRAME_FLAG_KEY;
    else input->flags &= ~AV_FRAME_FLAG_KEY;
#else
    input->key_frame = idr ? 1 : 0;
#endif

    if (const int code = avcodec_send_frame(context_, input)) {
      return finish(EncodeStatus::failed, "send: " + avError(code));
    }

    bool keyframe = false;
    while (true) {
      const int code = avcodec_receive_packet(context_, packet_);
      if (code == AVERROR(EAGAIN)) break;
      if (code < 0) {
        av_packet_unref(packet_);
        return finish(EncodeStatus::failed, "receive: " + avError(code));
      }
      res.annex_b.insert(res.annex_b.end(), packet_->data, packet_->data + packet_->size);
      keyframe |= (packet_->flags & AV_PKT_FLAG_KEY) != 0;
      av_packet_unref(packet_);
    }

    const uint64_t encode_ns =
        uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - started).count());
    if (res.annex_b.empty()) return finish(EncodeStatus::dropped, "encoder dropped frame");
    if (res.annex_b.size() > FlowControl::max_bytes) {
      res.annex_b.clear();
      return finish(EncodeStatus::failed, "encoded access unit too large");
    }
    res.status = EncodeStatus::encoded;
    res.keyframe = keyframe;
    res.converged = job.refinement && res.annex_b.size() <= rate / (4ull * std::max(1u, config_.fps));
    res.encode_ns = encode_ns;
    return res;
  }

  int freeSlot() const {
    for (int i = 0; i < slot_count; ++i) {
      if (!slot_busy_[i]) return i;
    }
    return -1;
  }

  /** Picks the slot the caller writes next, copying the newest frame when the ring rotates. */
  int chooseSlot() {
    if (latest_ >= 0 && !slot_busy_[latest_]) return latest_;
    const int target = freeSlot();
    if (target < 0) return -1;
    if (latest_ >= 0) copyFrame(slots_[target], slots_[latest_]);
    return target;
  }

  EncoderPlanes slotPlanes(int slot) const {
    AVFrame* frame = slots_[slot];
    if (!frame) return {};
    if (format_ != AV_PIX_FMT_NV12) return {{frame->data[0], nullptr}, {frame->linesize[0], 0}};
    return {{frame->data[0], frame->data[1]}, {frame->linesize[0], frame->linesize[1]}};
  }

  /** Copies one ring frame over another so callers only have to rewrite damaged regions. */
  void copyFrame(AVFrame* target, const AVFrame* source) const {
    if (!target || !source || target->format != source->format) return;
    const int planes = format_ == AV_PIX_FMT_NV12 ? 2 : 1;
    for (int plane = 0; plane < planes; ++plane) {
      const int rows = plane ? config_.height / 2 : config_.height;
      const int bytes = std::min(target->linesize[plane], source->linesize[plane]);
      for (int y = 0; y < rows; ++y) {
        std::memcpy(target->data[plane] + size_t(y) * size_t(target->linesize[plane]),
                    source->data[plane] + size_t(y) * size_t(source->linesize[plane]), size_t(bytes));
      }
    }
  }

  void closeCodec() { avcodec_free_context(&context_); }

  bool openCodec(const char* options, std::string& error) {
    closeCodec();
    const AVCodec* codec = avcodec_find_encoder_by_name(name_.c_str());
    if (!codec) {
      error = "not built into libavcodec";
      return false;
    }
    context_ = avcodec_alloc_context3(codec);
    if (!context_) {
      error = "out of memory";
      return false;
    }
    context_->width = config_.width;
    context_->height = config_.height;
    context_->time_base = AVRational{1, 1000000};
    context_->framerate = AVRational{int(config_.fps), 1};
    context_->pix_fmt = format_;
    context_->max_b_frames = 0;
    context_->gop_size = candidate_ && candidate_->upload == AV_HWDEVICE_TYPE_VAAPI ? INT16_MAX : INT_MAX;
    context_->keyint_min = INT_MAX;
    context_->flags |= AV_CODEC_FLAG_LOW_DELAY | AV_CODEC_FLAG_CLOSED_GOP;
    context_->flags2 |= AV_CODEC_FLAG2_FAST;
    context_->bit_rate = context_->rc_max_rate = int64_t(bitrate_);
    context_->rc_buffer_size = libavVbvBufferBits(bitrate_, config_.fps);
    context_->color_range = AVCOL_RANGE_MPEG;
    context_->colorspace = AVCOL_SPC_BT709;
    context_->color_primaries = AVCOL_PRI_BT709;
    context_->color_trc = AVCOL_TRC_BT709;

    if (candidate_ && candidate_->upload != AV_HWDEVICE_TYPE_NONE) {
      if (!device_) {
        if (const int code = av_hwdevice_ctx_create(&device_, candidate_->upload, nullptr, nullptr, 0)) {
          error = "no device: " + avError(code);
          closeCodec();
          return false;
        }
      }
      AVBufferRef* frames = av_hwframe_ctx_alloc(device_);
      if (!frames) {
        error = "out of memory";
        closeCodec();
        return false;
      }
      auto* cfg = reinterpret_cast<AVHWFramesContext*>(frames->data);
      cfg->format = AV_PIX_FMT_VAAPI;
      cfg->sw_format = AV_PIX_FMT_NV12;
      cfg->width = config_.width;
      cfg->height = config_.height;
      cfg->initial_pool_size = 4;
      if (const int code = av_hwframe_ctx_init(frames)) {
        av_buffer_unref(&frames);
        error = "no frame pool: " + avError(code);
        closeCodec();
        return false;
      }
      context_->pix_fmt = AV_PIX_FMT_VAAPI;
      context_->hw_frames_ctx = frames;
    }

    AVDictionary* dict = nullptr;
    if (options) av_dict_parse_string(&dict, options, "=", ":", 0);
    const int code = avcodec_open2(context_, codec, &dict);
    av_dict_free(&dict);
    if (code < 0) {
      error = avError(code);
      closeCodec();
      return false;
    }
    return true;
  }

  bool openWithFallback(std::string& error) {
    if (openCodec(candidate_ ? candidate_->options : nullptr, error)) return true;
    if (candidate_ && candidate_->fallback) {
      return openCodec(candidate_->fallback, error);
    }
    return false;
  }

  bool allocate() {
    for (AVFrame*& slot : slots_) av_frame_free(&slot);
    if (!packet_) packet_ = av_packet_alloc();
    if (!packet_) return false;
    for (AVFrame*& slot : slots_) {
      slot = av_frame_alloc();
      if (!slot) return false;
      slot->format = format_;
      slot->width = config_.width;
      slot->height = config_.height;
      if (av_frame_get_buffer(slot, 0) < 0) return false;
      blankFrame(slot);
    }
    return true;
  }

  /** Fills a freshly allocated ring frame with neutral luma and chroma. */
  void blankFrame(AVFrame* frame) const {
    if (format_ != AV_PIX_FMT_NV12) {
      std::memset(frame->data[0], 0, size_t(frame->linesize[0]) * size_t(config_.height));
      return;
    }
    std::memset(frame->data[0], 16, size_t(frame->linesize[0]) * size_t(config_.height));
    std::memset(frame->data[1], 128, size_t(frame->linesize[1]) * size_t(config_.height / 2));
  }

  const Candidate* candidate_ = nullptr;
  std::string name_;
  EncoderConfig config_;
  EncoderReadyCallback on_ready_;
  uint64_t bitrate_ = 0;
  AVPixelFormat format_ = AV_PIX_FMT_NV12;
  std::chrono::steady_clock::time_point changed_{};
  AVBufferRef* device_ = nullptr;
  AVCodecContext* context_ = nullptr;
  std::array<AVFrame*, slot_count> slots_{};
  AVFrame* upload_ = nullptr;
  AVPacket* packet_ = nullptr;
  bool open_ = false;
  int pending_slot_ = -1;
  int latest_ = -1;
  std::array<bool, slot_count> slot_busy_{};
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::thread worker_;
  std::deque<Job> jobs_;
  std::deque<EncodeResult> ready_;
  unsigned inflight_ = 0;
  bool stopping_ = false;
};
}  // namespace

std::unique_ptr<VideoEncoder> createLibavEncoder(const EncoderConfig& config, EncoderReadyCallback on_ready, std::string& error) {
  av_log_set_level(AV_LOG_FATAL);
  if (config.preference != "auto") {
    const Candidate* known = nullptr;
    for (const auto& candidate : candidates) {
      if (config.preference == candidate.name) known = &candidate;
    }
    auto enc = std::make_unique<LibavEncoder>(known, config.preference, config, std::move(on_ready));
    if (enc->init(error)) return enc;
    return nullptr;
  }
  for (const auto& candidate : candidates) {
    if (hardwareEncoderCoolingDown(candidate.name)) continue;
    std::string reason;
    auto enc = std::make_unique<LibavEncoder>(&candidate, candidate.name, config, on_ready);
    if (enc->init(reason)) return enc;
    error = std::string(candidate.name) + ": " + reason;
  }
  return nullptr;
}

}  // namespace relay
#endif
