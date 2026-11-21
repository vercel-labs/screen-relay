#include "core/encoder.hpp"
#include "core/flow.hpp"
#include <VideoToolbox/VideoToolbox.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

namespace relay {
namespace {
constexpr unsigned vt_max_inflight = 3;

struct VtFrameContext {
  uint64_t tag = 0;
  int64_t pts_us = 0;
  bool refinement = false;
  uint64_t bitrate_bps = 0;
  std::chrono::steady_clock::time_point submitted{};
};

void appendStartCode(std::vector<uint8_t>& out) {
  out.push_back(0);
  out.push_back(0);
  out.push_back(0);
  out.push_back(1);
}

/** Sets VUI bitstream_restriction (max_num_reorder_frames=0) on an H.264 SPS so WebCodecs never buffers frame 1. */
std::vector<uint8_t> patchSpsZeroReorder(const uint8_t* raw, size_t len) {
  std::vector<uint8_t> original(raw, raw + len);
  if (len < 4 || (raw[0] & 31) != 7) return original;

  std::vector<uint8_t> rbsp;
  rbsp.reserve(len);
  for (size_t i = 1; i < len; ++i) {
    if (i >= 3 && raw[i - 2] == 0 && raw[i - 1] == 0 && raw[i] == 3) continue;
    rbsp.push_back(raw[i]);
  }
  if (rbsp.empty()) return original;

  size_t total_bits = rbsp.size() * 8;
  while (total_bits > 0) {
    const size_t idx = total_bits - 1;
    const bool bit = ((rbsp[idx / 8] >> (7 - (idx % 8))) & 1) != 0;
    --total_bits;
    if (bit) break;
  }

  size_t pos = 0;
  auto readBit = [&](uint32_t& out_bit) -> bool {
    if (pos >= total_bits) return false;
    out_bit = (rbsp[pos / 8] >> (7 - (pos % 8))) & 1u;
    ++pos;
    return true;
  };
  auto readBits = [&](int count, uint32_t& out_val) -> bool {
    out_val = 0;
    for (int i = 0; i < count; ++i) {
      uint32_t b = 0;
      if (!readBit(b)) return false;
      out_val = (out_val << 1) | b;
    }
    return true;
  };
  auto readUe = [&](uint32_t& out_val) -> bool {
    int zeros = 0;
    uint32_t b = 0;
    while (true) {
      if (!readBit(b)) return false;
      if (b) break;
      if (++zeros > 31) return false;
    }
    uint32_t suffix = 0;
    if (zeros && !readBits(zeros, suffix)) return false;
    out_val = ((1u << zeros) - 1u) + suffix;
    return true;
  };
  auto skipScalingList = [&](int size) -> bool {
    int last = 8, next = 8;
    for (int j = 0; j < size; ++j) {
      if (next != 0) {
        uint32_t code = 0;
        if (!readUe(code)) return false;
        const int delta = (code & 1u) ? int((code + 1u) / 2u) : -int(code / 2u);
        next = (last + delta + 256) % 256;
      }
      last = (next == 0) ? last : next;
    }
    return true;
  };

  uint32_t profile = 0, tmp = 0;
  if (!readBits(8, profile) || !readBits(8, tmp) || !readBits(8, tmp) || !readUe(tmp)) return original;
  if (profile == 100 || profile == 110 || profile == 122 || profile == 244 || profile == 44 ||
      profile == 83 || profile == 86 || profile == 118 || profile == 128 || profile == 138) {
    uint32_t chroma = 0, seq_scale = 0;
    if (!readUe(chroma)) return original;
    if (chroma == 3 && !readBits(1, tmp)) return original;
    if (!readUe(tmp) || !readUe(tmp) || !readBits(1, tmp) || !readBits(1, seq_scale)) return original;
    if (seq_scale) {
      const int lists = (chroma != 3) ? 8 : 12;
      for (int i = 0; i < lists; ++i) {
        uint32_t present = 0;
        if (!readBit(present)) return original;
        if (present && !skipScalingList(i < 6 ? 16 : 64)) return original;
      }
    }
  }
  uint32_t poc_type = 0;
  if (!readUe(tmp) || !readUe(poc_type)) return original;
  if (poc_type == 0) {
    if (!readUe(tmp)) return original;
  } else if (poc_type == 1) {
    uint32_t count = 0;
    if (!readBits(1, tmp) || !readUe(tmp) || !readUe(tmp) || !readUe(count)) return original;
    for (uint32_t i = 0; i < count; ++i) if (!readUe(tmp)) return original;
  }
  uint32_t max_refs = 0, frame_mbs_only = 0, crop = 0;
  if (!readUe(max_refs) || !readBits(1, tmp) || !readUe(tmp) || !readUe(tmp) || !readBit(frame_mbs_only)) return original;
  if (!frame_mbs_only && !readBits(1, tmp)) return original;
  if (!readBits(1, tmp) || !readBit(crop)) return original;
  if (crop) {
    for (int i = 0; i < 4; ++i) if (!readUe(tmp)) return original;
  }

  const size_t vui_flag_pos = pos;
  uint32_t vui_present = 0;
  if (!readBit(vui_present)) return original;

  size_t br_flag_pos = 0;
  if (vui_present) {
    uint32_t flag = 0;
    if (!readBit(flag)) return original;
    if (flag) {
      uint32_t idc = 0;
      if (!readBits(8, idc)) return original;
      if (idc == 255 && (!readBits(16, tmp) || !readBits(16, tmp))) return original;
    }
    if (!readBit(flag)) return original;
    if (flag && !readBit(tmp)) return original;
    if (!readBit(flag)) return original;
    if (flag) {
      uint32_t colour = 0;
      if (!readBits(3, tmp) || !readBit(tmp) || !readBit(colour)) return original;
      if (colour && (!readBits(8, tmp) || !readBits(8, tmp) || !readBits(8, tmp))) return original;
    }
    if (!readBit(flag)) return original;
    if (flag && (!readUe(tmp) || !readUe(tmp))) return original;
    if (!readBit(flag)) return original;
    if (flag && (!readBits(32, tmp) || !readBits(32, tmp) || !readBit(tmp))) return original;
    uint32_t nal_hrd = 0, vcl_hrd = 0;
    if (!readBit(nal_hrd)) return original;
    if (nal_hrd) return original;
    if (!readBit(vcl_hrd)) return original;
    if (vcl_hrd) return original;
    if (!readBit(tmp)) return original;
    br_flag_pos = pos;
    uint32_t br_present = 0;
    if (!readBit(br_present)) return original;
    if (br_present || pos != total_bits) return original;
  } else if (pos != total_bits) {
    return original;
  }

  std::vector<uint8_t> out_bits;
  auto pushBit = [&](uint32_t b) { out_bits.push_back(uint8_t(b & 1u)); };
  auto pushUe = [&](uint32_t val) {
    const uint32_t code = val + 1u;
    int bits = 0;
    for (uint32_t v = code; v > 1u; v >>= 1) ++bits;
    for (int i = 0; i < bits; ++i) pushBit(0);
    for (int i = bits; i >= 0; --i) pushBit((code >> i) & 1u);
  };

  const size_t copy_until = vui_present ? br_flag_pos : vui_flag_pos;
  out_bits.reserve(copy_until + 64);
  for (size_t i = 0; i < copy_until; ++i) {
    pushBit((rbsp[i / 8] >> (7 - (i % 8))) & 1u);
  }
  if (!vui_present) {
    pushBit(1);
    for (int i = 0; i < 8; ++i) pushBit(0);
  }
  pushBit(1);
  pushBit(1);
  pushUe(0);
  pushUe(0);
  pushUe(11);
  pushUe(11);
  pushUe(0);
  pushUe(std::max<uint32_t>(1u, max_refs));
  pushBit(1);
  while (out_bits.size() % 8 != 0) pushBit(0);

  std::vector<uint8_t> patched;
  patched.reserve(len + 8);
  patched.push_back(raw[0]);
  int zero_count = 0;
  for (size_t i = 0; i < out_bits.size(); i += 8) {
    uint8_t byte = 0;
    for (size_t b = 0; b < 8; ++b) byte = uint8_t((byte << 1) | out_bits[i + b]);
    if (zero_count == 2 && byte <= 3) {
      patched.push_back(3);
      zero_count = 0;
    }
    patched.push_back(byte);
    zero_count = (byte == 0) ? (zero_count + 1) : 0;
  }
  return patched;
}

bool appendParameterSets(CMFormatDescriptionRef format, std::vector<uint8_t>& out, int& nal_header_length) {
  size_t count = 0;
  if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nullptr, nullptr, &count, &nal_header_length) != noErr) {
    return false;
  }
  for (size_t i = 0; i < count; ++i) {
    const uint8_t* bytes = nullptr;
    size_t length = 0;
    if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, i, &bytes, &length, nullptr, nullptr) != noErr ||
        !bytes || !length) {
      return false;
    }
    appendStartCode(out);
    if ((bytes[0] & 31) == 7) {
      const auto patched = patchSpsZeroReorder(bytes, length);
      out.insert(out.end(), patched.begin(), patched.end());
    } else {
      out.insert(out.end(), bytes, bytes + length);
    }
  }
  return count >= 2;
}

bool sampleToAnnexB(CMSampleBufferRef sample, bool& keyframe, std::vector<uint8_t>& out) {
  out.clear();
  keyframe = false;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  if (attachments && CFArrayGetCount(attachments) > 0) {
    CFDictionaryRef info = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
    if (info) {
      keyframe = !CFDictionaryContainsKey(info, kCMSampleAttachmentKey_NotSync) ||
                 !CFBooleanGetValue(static_cast<CFBooleanRef>(CFDictionaryGetValue(info, kCMSampleAttachmentKey_NotSync)));
    }
  }

  CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
  if (!format) return false;
  int nal_header_length = 4;
  if (keyframe) {
    if (!appendParameterSets(format, out, nal_header_length)) return false;
  } else {
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nullptr, nullptr, nullptr, &nal_header_length);
  }
  if (nal_header_length != 1 && nal_header_length != 2 && nal_header_length != 4) return false;

  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  if (!block) return false;
  size_t total_length = 0;
  char* raw_ptr = nullptr;
  std::vector<uint8_t> contiguous;
  const uint8_t* data = nullptr;
  if (CMBlockBufferIsRangeContiguous(block, 0, 0) &&
      CMBlockBufferGetDataPointer(block, 0, nullptr, &total_length, &raw_ptr) == noErr && raw_ptr) {
    data = reinterpret_cast<const uint8_t*>(raw_ptr);
  } else {
    total_length = CMBlockBufferGetDataLength(block);
    contiguous.resize(total_length);
    if (total_length && CMBlockBufferCopyDataBytes(block, 0, total_length, contiguous.data()) != noErr) return false;
    data = contiguous.data();
  }

  size_t offset = 0;
  while (offset + size_t(nal_header_length) <= total_length) {
    uint32_t nal_len = 0;
    for (int i = 0; i < nal_header_length; ++i) {
      nal_len = (nal_len << 8) | data[offset + size_t(i)];
    }
    offset += size_t(nal_header_length);
    if (nal_len == 0 || offset + nal_len > total_length) return false;
    appendStartCode(out);
    out.insert(out.end(), data + offset, data + offset + nal_len);
    offset += nal_len;
  }
  return !out.empty();
}

/** Native Apple VideoToolbox hardware H.264 encoder with zero-copy CVPixelBuffer support and shallow pipelining. */
class VideoToolboxEncoder final : public VideoEncoder {
 public:
  VideoToolboxEncoder(const EncoderConfig& config, EncoderReadyCallback on_ready)
      : config_(config), on_ready_(std::move(on_ready)), bitrate_(config.bitrate_bps) {}

  ~VideoToolboxEncoder() override { destroySession(); }

  bool init(std::string& error) {
    if (!config_.source_bgra) {
      error = "VideoToolbox expects BGRA input";
      return false;
    }
    return createSession(error);
  }

  const std::string& name() const override { return name_; }
  bool hardware() const override { return true; }
  TransferTier transferTier() const override { return TransferTier::zero_copy; }
  EncoderInput inputFormat() const override { return EncoderInput::native_handle; }
  unsigned maxInflight() const override { return vt_max_inflight; }

  unsigned inflight() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return inflight_;
  }

  EncoderPlanes planes() override {
    const size_t required = size_t(config_.width) * size_t(config_.height) * 4;
    if (staging_.size() != required) staging_.assign(required, 0);
    return {{staging_.data(), nullptr}, {config_.width * 4, 0}};
  }

  bool submit(const EncodeRequest& req, std::string& error) override {
    if (!session_) {
      error = "VideoToolbox session is not open";
      return false;
    }
    const uint64_t current_rate = bitrate_.load(std::memory_order_relaxed);
    const uint64_t rate = req.bitrate_bps ? req.bitrate_bps : current_rate;
    if (rate != current_rate) {
      updateBitrate(rate);
    }

    CVPixelBufferRef pixel_buffer = nullptr;
    bool release_pixel_buffer = false;
    if (req.native_handle) {
      pixel_buffer = static_cast<CVPixelBufferRef>(req.native_handle);
      if (last_native_buffer_ != pixel_buffer) {
        if (last_native_buffer_) CVPixelBufferRelease(last_native_buffer_);
        last_native_buffer_ = CVPixelBufferRetain(pixel_buffer);
      }
    } else if (req.refinement && last_native_buffer_) {
      pixel_buffer = last_native_buffer_;
    } else {
      CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(session_);
      if (!pool || CVPixelBufferPoolCreatePixelBuffer(nullptr, pool, &pixel_buffer) != kCVReturnSuccess || !pixel_buffer) {
        error = "allocating VideoToolbox CVPixelBuffer failed";
        return false;
      }
      release_pixel_buffer = true;
      if (CVPixelBufferLockBaseAddress(pixel_buffer, 0) != kCVReturnSuccess) {
        CVPixelBufferRelease(pixel_buffer);
        error = "locking VideoToolbox CVPixelBuffer failed";
        return false;
      }
      auto* dst = static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(pixel_buffer));
      const size_t dst_stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
      const size_t row_bytes = size_t(config_.width) * 4;
      if (!staging_.empty()) {
        for (int y = 0; y < config_.height; ++y) {
          std::memcpy(dst + size_t(y) * dst_stride, staging_.data() + size_t(y) * row_bytes, row_bytes);
        }
      } else {
        for (int y = 0; y < config_.height; ++y) {
          std::memset(dst + size_t(y) * dst_stride, 0, row_bytes);
        }
      }
      CVPixelBufferUnlockBaseAddress(pixel_buffer, 0);
    }

    CFMutableDictionaryRef frame_props = nullptr;
    if (req.force_idr) {
      frame_props = CFDictionaryCreateMutable(nullptr, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
      CFDictionarySetValue(frame_props, kVTEncodeFrameOptionKey_ForceKeyFrame, kCFBooleanTrue);
    }

    auto* ctx = new VtFrameContext{req.tag, req.pts_us, req.refinement, rate, std::chrono::steady_clock::now()};
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ++inflight_;
    }

    const CMTime pts = CMTimeMake(req.pts_us, 1000000);
    const CMTime duration = CMTimeMake(1000000 / std::max(1u, config_.fps), 1000000);
    const OSStatus status = VTCompressionSessionEncodeFrame(session_, pixel_buffer, pts, duration, frame_props, ctx, nullptr);
    if (frame_props) CFRelease(frame_props);
    if (release_pixel_buffer) CVPixelBufferRelease(pixel_buffer);

    if (status != noErr) {
      delete ctx;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (inflight_ > 0) --inflight_;
      }
      error = "VTCompressionSessionEncodeFrame failed (" + std::to_string(int(status)) + ")";
      return false;
    }
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
    if (session_) {
      VTCompressionSessionCompleteFrames(session_, kCMTimeInvalid);
    }
    poll(out, false);
  }

  bool reset(std::string& error) override {
    destroySession();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ready_.clear();
      inflight_ = 0;
      has_last_complete_ = false;
    }
    return createSession(error);
  }

 private:
  static void outputCallback(void* refcon, void* frame_refcon, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    auto* self = static_cast<VideoToolboxEncoder*>(refcon);
    std::unique_ptr<VtFrameContext> ctx(static_cast<VtFrameContext*>(frame_refcon));
    self->handleOutput(std::move(ctx), status, flags, sample);
  }

  void handleOutput(std::unique_ptr<VtFrameContext> ctx, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    const auto now = std::chrono::steady_clock::now();
    EncodeResult res;
    res.tag = ctx ? ctx->tag : 0;
    res.pts_us = ctx ? ctx->pts_us : 0;

    if (status != noErr) {
      res.status = EncodeStatus::failed;
      res.error = "VideoToolbox callback error (" + std::to_string(int(status)) + ")";
    } else if (!sample || (flags & kVTEncodeInfo_FrameDropped)) {
      res.status = EncodeStatus::dropped;
      res.error = "VideoToolbox dropped frame";
    } else if (!sampleToAnnexB(sample, res.keyframe, res.annex_b)) {
      res.status = EncodeStatus::failed;
      res.error = "converting VideoToolbox sample to Annex B failed";
    } else if (res.annex_b.size() > FlowControl::max_bytes) {
      res.status = EncodeStatus::failed;
      res.error = "encoded access unit too large";
      res.annex_b.clear();
    } else {
      res.status = EncodeStatus::encoded;
      const uint64_t rate = ctx && ctx->bitrate_bps ? ctx->bitrate_bps : bitrate_.load(std::memory_order_relaxed);
      res.converged = ctx && ctx->refinement && res.annex_b.size() <= rate / (4ull * std::max(1u, config_.fps));
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (ctx) {
        const auto start = (has_last_complete_ && last_complete_ > ctx->submitted) ? last_complete_ : ctx->submitted;
        res.encode_ns = now > start
            ? uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(now - start).count())
            : 0;
      }
      last_complete_ = now;
      has_last_complete_ = true;
      ready_.push_back(std::move(res));
      if (inflight_ > 0) --inflight_;
    }
    cv_.notify_one();
    if (on_ready_) on_ready_();
  }

  /** Updates the average bitrate and the one-second data rate cap VideoToolbox enforces between keyframes. */
  void updateBitrate(uint64_t rate) {
    bitrate_.store(rate, std::memory_order_relaxed);
    if (!session_) return;
    const int64_t clamped = int64_t(std::min<uint64_t>(rate, uint64_t(INT32_MAX)));
    int32_t avg = int32_t(clamped);
    CFNumberRef cf_br = CFNumberCreate(nullptr, kCFNumberSInt32Type, &avg);
    if (cf_br) {
      VTSessionSetProperty(session_, kVTCompressionPropertyKey_AverageBitRate, cf_br);
      CFRelease(cf_br);
    }
    int64_t bytes_per_second = std::max<int64_t>(int64_t(rate * 3 / 16), 16384);
    double seconds = 1.0;
    CFNumberRef cf_bytes = CFNumberCreate(nullptr, kCFNumberSInt64Type, &bytes_per_second);
    CFNumberRef cf_seconds = CFNumberCreate(nullptr, kCFNumberDoubleType, &seconds);
    if (cf_bytes && cf_seconds) {
      const void* values[] = {cf_bytes, cf_seconds};
      CFArrayRef limits = CFArrayCreate(nullptr, values, 2, &kCFTypeArrayCallBacks);
      if (limits) {
        VTSessionSetProperty(session_, kVTCompressionPropertyKey_DataRateLimits, limits);
        CFRelease(limits);
      }
    }
    if (cf_bytes) CFRelease(cf_bytes);
    if (cf_seconds) CFRelease(cf_seconds);
  }

  /** Creates the hardware compression session configured for real-time limited-range BT.709 H.264 output. */
  bool createSession(std::string& error) {
    destroySession();
    CFMutableDictionaryRef enc_spec = CFDictionaryCreateMutable(nullptr, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(enc_spec, kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder, kCFBooleanTrue);
    CFDictionarySetValue(enc_spec, kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder, kCFBooleanTrue);

    CFMutableDictionaryRef src_attrs = CFDictionaryCreateMutable(nullptr, 4, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    int32_t pix_fmt = kCVPixelFormatType_32BGRA;
    CFNumberRef cf_pix = CFNumberCreate(nullptr, kCFNumberSInt32Type, &pix_fmt);
    CFDictionaryRef io_props = CFDictionaryCreate(nullptr, nullptr, nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(src_attrs, kCVPixelBufferPixelFormatTypeKey, cf_pix);
    CFDictionarySetValue(src_attrs, kCVPixelBufferIOSurfacePropertiesKey, io_props);
    CFRelease(io_props);
    CFRelease(cf_pix);

    const OSStatus created = VTCompressionSessionCreate(nullptr, config_.width, config_.height, kCMVideoCodecType_H264,
                                                        enc_spec, src_attrs, nullptr, outputCallback, this, &session_);
    CFRelease(src_attrs);
    CFRelease(enc_spec);
    if (created != noErr || !session_) {
      session_ = nullptr;
      error = "VTCompressionSessionCreate failed (" + std::to_string(int(created)) + ")";
      return false;
    }

    VTSessionSetProperty(session_, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_AllowTemporalCompression, kCFBooleanTrue);
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue);
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2);
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2);
    VTSessionSetProperty(session_, kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2);

    int32_t expected_fps = int32_t(std::max(1u, config_.fps));
    CFNumberRef cf_fps = CFNumberCreate(nullptr, kCFNumberSInt32Type, &expected_fps);
    if (cf_fps) {
      VTSessionSetProperty(session_, kVTCompressionPropertyKey_ExpectedFrameRate, cf_fps);
      CFRelease(cf_fps);
    }
    int32_t max_keyframe = INT32_MAX;
    CFNumberRef cf_gop = CFNumberCreate(nullptr, kCFNumberSInt32Type, &max_keyframe);
    if (cf_gop) {
      VTSessionSetProperty(session_, kVTCompressionPropertyKey_MaxKeyFrameInterval, cf_gop);
      CFRelease(cf_gop);
    }

    updateBitrate(bitrate_.load(std::memory_order_relaxed));

    const OSStatus prepared = VTCompressionSessionPrepareToEncodeFrames(session_);
    if (prepared != noErr) {
      destroySession();
      error = "VTCompressionSessionPrepareToEncodeFrames failed (" + std::to_string(int(prepared)) + ")";
      return false;
    }
    return true;
  }

  void destroySession() {
    if (session_) {
      VTCompressionSessionCompleteFrames(session_, kCMTimeInvalid);
      VTCompressionSessionInvalidate(session_);
      CFRelease(session_);
      session_ = nullptr;
    }
    if (last_native_buffer_) {
      CVPixelBufferRelease(last_native_buffer_);
      last_native_buffer_ = nullptr;
    }
  }

  std::string name_ = "videotoolbox";
  EncoderConfig config_;
  EncoderReadyCallback on_ready_;
  std::atomic<uint64_t> bitrate_{0};
  std::vector<uint8_t> staging_;
  CVPixelBufferRef last_native_buffer_ = nullptr;
  VTCompressionSessionRef session_ = nullptr;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<EncodeResult> ready_;
  unsigned inflight_ = 0;
  std::chrono::steady_clock::time_point last_complete_{};
  bool has_last_complete_ = false;
};
}  // namespace

std::unique_ptr<VideoEncoder> createVideoToolboxEncoder(const EncoderConfig& config, EncoderReadyCallback on_ready, std::string& error) {
  auto enc = std::make_unique<VideoToolboxEncoder>(config, std::move(on_ready));
  if (!enc->init(error)) return nullptr;
  return enc;
}

}  // namespace relay
