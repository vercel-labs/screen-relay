#pragma once

#include "capture-source.hpp"
#include "image-scale.hpp"
#include "surface-budget.hpp"
#include <algorithm>
#include <cstring>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace relay {

/** CaptureSource decorator that scales oversized or odd-dimensioned frames into a SurfacePlan budget. */
class ScaledCaptureSource final : public CaptureSource {
 public:
  ScaledCaptureSource(std::unique_ptr<CaptureSource> inner, const SurfacePlan& plan)
      : inner_(std::move(inner)),
        src_width_(plan.source_width),
        src_height_(plan.source_height),
        dst_width_(plan.stream_width),
        dst_height_(plan.stream_height),
        format_(inner_->pixelFormat()),
        dst_buffer_(size_t(dst_width_) * size_t(dst_height_) * 4u, 0) {
    table_.build(src_width_, src_height_, dst_width_, dst_height_);
  }

  WaitHandle fd() const override { return inner_->fd(); }
  std::pair<int, int> dimensions() const override { return {dst_width_, dst_height_}; }
  bool drainDamage() override { return inner_->drainDamage(); }
  PixelFormat pixelFormat() const override { return format_; }
  bool cursorSupported() const override { return inner_->cursorSupported(); }

  std::optional<CursorImage> cursor(bool force) override {
    auto raw = inner_->cursor(force);
    if (!raw || raw->width == 0 || raw->height == 0) return raw;
    const uint16_t scaled_w = uint16_t(std::clamp(
        int(int64_t(raw->width) * dst_width_ / src_width_), 1, int(CursorImage::max_extent)));
    const uint16_t scaled_h = uint16_t(std::clamp(
        int(int64_t(raw->height) * dst_height_ / src_height_), 1, int(CursorImage::max_extent)));
    if (scaled_w == raw->width && scaled_h == raw->height) return raw;
    CursorImage out;
    out.width = scaled_w;
    out.height = scaled_h;
    out.xhot = uint16_t(std::min<int>(scaled_w - 1, int(int64_t(raw->xhot) * scaled_w / raw->width)));
    out.yhot = uint16_t(std::min<int>(scaled_h - 1, int(int64_t(raw->yhot) * scaled_h / raw->height)));
    out.rgba.resize(size_t(scaled_w) * size_t(scaled_h) * 4u);
    scaleStraightAlphaRgba(raw->rgba.data(), int(raw->width), int(raw->height),
                           out.rgba.data(), int(scaled_w), int(scaled_h));
    return out;
  }

  FrameView capture() override {
    const FrameView view = inner_->capture();
    validateSourceView(view, true);
    if (state_ == SourceState::shadowed) state_ = SourceState::direct;
    scaleInto(view.data, view.stride, {0, 0, dst_width_, dst_height_});
    report_.reset();
    return streamView();
  }

  FrameView captureChanged(bool full) override {
    const bool need_full = full || state_ == SourceState::awaiting_full;
    const FrameView view = inner_->captureChanged(need_full);
    validateSourceView(view, need_full);
    report_.reset();
    std::vector<DamageRect> src_rects;
    const bool known = !need_full && inner_->changedRects(src_rects);
    const bool full_view = view.x == 0 && view.y == 0 && view.width == src_width_ && view.height == src_height_;

    if (full_view) {
      if (state_ == SourceState::shadowed) copyToShadow(view);
      if (state_ == SourceState::awaiting_full) state_ = SourceState::direct;
      if (!known) {
        scaleInto(view.data, view.stride, {0, 0, dst_width_, dst_height_});
        return streamView();
      }
      report_ = mapToStream(src_rects);
      for (const auto& rect : *report_) scaleInto(view.data, view.stride, rect);
      return streamView();
    }

    if (!known || src_rects.empty()) src_rects = {{view.x, view.y, view.width, view.height}};
    if (state_ == SourceState::shadowed) {
      copySubRectToShadow(view);
      report_ = mapToStream(src_rects);
      for (const auto& rect : *report_) scaleInto(src_shadow_.data(), src_width_ * 4, rect);
      return streamView();
    }

    const FrameView full_frame = inner_->capture();
    validateSourceView(full_frame, true);
    copyToShadow(full_frame);
    state_ = SourceState::shadowed;
    std::vector<DamageRect> extra_rects;
    if (inner_->changedRects(extra_rects)) src_rects.insert(src_rects.end(), extra_rects.begin(), extra_rects.end());
    scaleInto(src_shadow_.data(), src_width_ * 4, {0, 0, dst_width_, dst_height_});
    report_ = mapToStream(src_rects);
    return streamView();
  }

  bool changedRects(std::vector<DamageRect>& out) override {
    if (!report_) return false;
    out = *report_;
    return true;
  }

 private:
  /** Source pixels the scaler reads: none yet (next capture must be full), full views direct from the source, or a full-resolution shadow kept current from partial views. */
  enum class SourceState : uint8_t { awaiting_full, direct, shadowed };

  FrameView streamView() const { return {dst_buffer_.data(), dst_width_ * 4, dst_width_, dst_height_, format_, 0, 0}; }

  void scaleInto(const uint8_t* src, int src_stride, const DamageRect& rect) {
    scaleRgbaRect(src, src_stride, table_, dst_buffer_.data(), dst_width_ * 4, rect);
  }

  std::vector<DamageRect> mapToStream(const std::vector<DamageRect>& rects) const {
    std::vector<DamageRect> mapped;
    for (const auto& rect : rects) {
      const DamageRect m = mapDamageRect(rect, src_width_, src_height_, dst_width_, dst_height_);
      if (m.width > 0 && m.height > 0) mapped.push_back(m);
    }
    return mapped;
  }

  void validateSourceView(const FrameView& view, bool require_full) const {
    if (!view.data || view.width <= 0 || view.height <= 0 ||
        view.x < 0 || view.y < 0 || view.x > src_width_ || view.y > src_height_ ||
        view.width > src_width_ - view.x || view.height > src_height_ - view.y ||
        view.stride < view.width * 4 || view.stride > src_width_ * 8 ||
        (require_full && (view.x != 0 || view.y != 0 || view.width != src_width_ || view.height != src_height_)) ||
        view.format != format_) {
      throw std::runtime_error("invalid capture frame");
    }
  }

  void copyToShadow(const FrameView& view) {
    src_shadow_.resize(size_t(src_width_) * size_t(src_height_) * 4u);
    for (int y = 0; y < src_height_; ++y) {
      std::memcpy(src_shadow_.data() + size_t(y) * size_t(src_width_) * 4u,
                  view.data + size_t(y) * size_t(view.stride), size_t(src_width_) * 4u);
    }
  }

  void copySubRectToShadow(const FrameView& view) {
    for (int y = 0; y < view.height; ++y) {
      std::memcpy(src_shadow_.data() + (size_t(view.y + y) * size_t(src_width_) + size_t(view.x)) * 4u,
                  view.data + size_t(y) * size_t(view.stride), size_t(view.width) * 4u);
    }
  }

  std::unique_ptr<CaptureSource> inner_;
  int src_width_ = 0;
  int src_height_ = 0;
  int dst_width_ = 0;
  int dst_height_ = 0;
  PixelFormat format_ = PixelFormat::BGRA;
  RgbaScaleTable table_;
  std::vector<uint8_t> dst_buffer_;
  std::vector<uint8_t> src_shadow_;
  SourceState state_ = SourceState::awaiting_full;
  std::optional<std::vector<DamageRect>> report_;
};

/** Wraps source with ScaledCaptureSource only when its dimensions exceed the H.264 Level 5.2 budget for fps. */
inline std::unique_ptr<CaptureSource> fitCaptureSourceToBudget(std::unique_ptr<CaptureSource> source,
                                                               unsigned fps, SurfacePlan* out_plan = nullptr) {
  if (!source) throw std::runtime_error("capture source unavailable");
  const auto dims = source->dimensions();
  const SurfaceBudget budget = SurfaceBudget::forFps(fps);
  const SurfacePlan plan = planSurface(dims.first, dims.second, budget, SurfaceScaleMode::exact);
  if (out_plan) *out_plan = plan;
  if (!plan.ok()) {
    throw std::runtime_error("Unsupported root size " + std::to_string(dims.first) + "x" +
                             std::to_string(dims.second) + " for H.264 level 5.2 at " +
                             std::to_string(budget.fps) + " fps");
  }
  if (!plan.scaled()) return source;
  return std::make_unique<ScaledCaptureSource>(std::move(source), plan);
}

}  // namespace relay
