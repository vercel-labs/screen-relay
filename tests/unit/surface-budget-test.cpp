#include "core/scaled-capture.hpp"
#include "core/surface-budget.hpp"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

namespace {
void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "surface-budget-test failed: %s\n", message);
    std::exit(1);
  }
}

class SyntheticSource final : public relay::CaptureSource {
 public:
  SyntheticSource(int w, int h, relay::PixelFormat fmt = relay::PixelFormat::BGRA)
      : width_(w), height_(h), format_(fmt), pixels_(size_t(w) * size_t(h) * 4u, 0) {
    fillSolid(40, 120, 200);
  }

  void fillSolid(uint8_t b, uint8_t g, uint8_t r) {
    for (size_t i = 0; i < pixels_.size(); i += 4) {
      pixels_[i] = b;
      pixels_[i + 1] = g;
      pixels_[i + 2] = r;
      pixels_[i + 3] = 255;
    }
  }

  void paintRect(int x, int y, int w, int h, uint8_t b, uint8_t g, uint8_t r) {
    for (int row = y; row < y + h; ++row) {
      for (int col = x; col < x + w; ++col) {
        uint8_t* p = pixels_.data() + (size_t(row) * size_t(width_) + size_t(col)) * 4u;
        p[0] = b;
        p[1] = g;
        p[2] = r;
        p[3] = 255;
      }
    }
    sub_rect_ = {x, y, w, h};
    has_sub_rect_ = true;
  }

  relay::WaitHandle fd() const override { return relay::WaitHandle{}; }
  std::pair<int, int> dimensions() const override { return {width_, height_}; }
  bool drainDamage() override { return true; }
  relay::PixelFormat pixelFormat() const override { return format_; }
  bool cursorSupported() const override { return true; }

  std::optional<relay::CursorImage> cursor(bool) override {
    relay::CursorImage cur;
    cur.width = 32;
    cur.height = 32;
    cur.xhot = 8;
    cur.yhot = 12;
    cur.rgba.assign(32u * 32u * 4u, 200);
    return cur;
  }

  void setCaptureOverrideDamage(relay::DamageRect rect) {
    override_damage_ = rect;
    has_override_damage_ = true;
  }

  relay::FrameView capture() override {
    if (has_override_damage_) {
      sub_rect_ = override_damage_;
      has_sub_rect_ = true;
      has_override_damage_ = false;
    }
    return {pixels_.data(), width_ * 4, width_, height_, format_, 0, 0};
  }

  relay::FrameView captureChanged(bool full) override {
    if (full || !has_sub_rect_) return capture();
    sub_pixels_.resize(size_t(sub_rect_.width) * size_t(sub_rect_.height) * 4u);
    for (int row = 0; row < sub_rect_.height; ++row) {
      std::memcpy(sub_pixels_.data() + size_t(row) * size_t(sub_rect_.width) * 4u,
                  pixels_.data() + (size_t(sub_rect_.y + row) * size_t(width_) + size_t(sub_rect_.x)) * 4u,
                  size_t(sub_rect_.width) * 4u);
    }
    return {sub_pixels_.data(), sub_rect_.width * 4, sub_rect_.width, sub_rect_.height, format_, sub_rect_.x, sub_rect_.y};
  }

  bool changedRects(std::vector<relay::DamageRect>& out) override {
    if (!has_sub_rect_) return false;
    out = {sub_rect_};
    return true;
  }

 private:
  int width_, height_;
  relay::PixelFormat format_;
  std::vector<uint8_t> pixels_;
  std::vector<uint8_t> sub_pixels_;
  relay::DamageRect sub_rect_{};
  bool has_sub_rect_ = false;
  relay::DamageRect override_damage_{};
  bool has_override_damage_ = false;
};
}  // namespace

int main() {
  using namespace relay;

  require(h264LevelIdc(1280, 720, 60) == 32, "720p60 should be level 3.2");
  require(h264LevelIdc(1920, 1080, 60) == 42, "1080p60 should be level 4.2");
  require(h264LevelIdc(3840, 2160, 60) == 52, "4K60 should be level 5.2");
  require(h264LevelIdc(3008, 1692, 60) == 52, "3008x1692@60 should be level 5.2");
  require(h264LevelIdc(3008, 1692, 120) == 60, "3008x1692@120 exceeds level 5.2 (level 6.0)");
  require(h264LevelIdc(6016, 3384, 60) == 61, "6016x3384@60 should be level 6.1");

  {
    const auto p = planSurface(3840, 2160, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p.state == SurfaceFitState::native && !p.scaled(), "4K60 must stay native");
    require(p.stream_width == 3840 && p.stream_height == 2160 && p.h264_level_idc == 52, "4K60 plan mismatch");
  }
  {
    const auto p = planSurface(2160, 3840, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p.state == SurfaceFitState::native && p.stream_width == 2160 && p.stream_height == 3840,
            "portrait 4K60 must stay native");
  }
  {
    const auto p = planSurface(3024, 1964, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p.state == SurfaceFitState::native, "14-inch MBP Retina must stay native");
  }
  {
    const auto p = planSurface(3456, 2234, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p.state == SurfaceFitState::native, "16-inch MBP Retina must stay native");
  }
  {
    const auto p = planSurface(1365, 767, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p.state == SurfaceFitState::clamped_even && p.stream_width == 1364 && p.stream_height == 766,
            "odd dimensions must clamp even");
  }
  {
    const auto p = planSurface(5120, 1440, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p.state == SurfaceFitState::scaled_axis_limit && p.stream_width == 4096 && p.stream_height == 1152,
            "5120x1440 ultrawide must scale to 4096 axis limit");
    require(p.h264_level_idc <= 52, "ultrawide must fit level 5.2");
  }
  {
    const auto p60 = planSurface(6016, 3384, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p60.state == SurfaceFitState::scaled_level_budget && p60.ok() && p60.scaled(), "6K@60 must scale");
    require(p60.h264_level_idc <= 52 && p60.stream_width <= 4096 && p60.stream_height <= 4096, "6K@60 must fit level 5.2");
    require((p60.stream_width & 1) == 0 && (p60.stream_height & 1) == 0, "6K@60 stream size must be even");
    require(std::abs(double(p60.stream_width) / p60.stream_height - 6016.0 / 3384.0) < 0.01, "6K@60 aspect drift");

    const auto p120 = planSurface(6016, 3384, SurfaceBudget::forFps(120), SurfaceScaleMode::exact);
    require(p120.state == SurfaceFitState::scaled_level_budget && p120.h264_level_idc <= 52, "6K@120 must fit level 5.2");
    require(p120.stream_width < p60.stream_width, "120 fps must scale smaller than 60 fps");
  }
  {
    const auto p3k60 = planSurface(3008, 1692, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(p3k60.state == SurfaceFitState::native, "3008x1692@60 must stay native");
    const auto p3k120 = planSurface(3008, 1692, SurfaceBudget::forFps(120), SurfaceScaleMode::exact);
    require(p3k120.state == SurfaceFitState::scaled_level_budget && p3k120.h264_level_idc <= 52,
            "3008x1692@120 must scale down to level 5.2");
  }
  {
    const auto win6k = planSurface(6016, 3384, SurfaceBudget::forFps(60), SurfaceScaleMode::power_of_two);
    require(win6k.ok() && win6k.shift == 1 && win6k.stream_width == 3008 && win6k.stream_height == 1692,
            "Windows power-of-two 6K@60 must shift by 1 to 3008x1692");
    const auto win4k120 = planSurface(3840, 2160, SurfaceBudget::forFps(120), SurfaceScaleMode::power_of_two);
    require(win4k120.ok() && win4k120.shift == 1 && win4k120.stream_width == 1920 && win4k120.stream_height == 1080,
            "Windows power-of-two 4K@120 must shift by 1 to 1920x1080");
    const auto win8k60 = planSurface(7680, 4320, SurfaceBudget::forFps(60), SurfaceScaleMode::power_of_two);
    require(win8k60.ok() && win8k60.shift == 1 && win8k60.stream_width == 3840 && win8k60.stream_height == 2160,
            "Windows power-of-two 8K@60 must shift by 1 to 3840x2160");
  }
  {
    const auto rejected = planSurface(20000, 240, SurfaceBudget::forFps(60), SurfaceScaleMode::exact);
    require(!rejected.ok() && rejected.state == SurfaceFitState::rejected, "extreme aspect ratio must be rejected");
  }

  {
    auto raw = std::make_unique<SyntheticSource>(1280, 720);
    auto* raw_ptr = raw.get();
    SurfacePlan plan;
    auto fitted = fitCaptureSourceToBudget(std::move(raw), 60, &plan);
    require(fitted.get() == raw_ptr && !plan.scaled(), "native source must not be wrapped");
  }
  {
    auto raw = std::make_unique<SyntheticSource>(5120, 2880);
    auto* raw_ptr = raw.get();
    SurfacePlan plan;
    auto fitted = fitCaptureSourceToBudget(std::move(raw), 60, &plan);
    require(fitted.get() != raw_ptr && plan.scaled(), "5K source must be wrapped by ScaledCaptureSource");
    const auto dims = fitted->dimensions();
    require(dims.first == plan.stream_width && dims.second == plan.stream_height, "scaled dimensions mismatch");
    const auto initial = fitted->captureChanged(true);
    require(initial.width == dims.first && initial.height == dims.second, "initial scaled frame size mismatch");
    require(initial.data[0] == 40 && initial.data[1] == 120 && initial.data[2] == 200, "initial solid color mismatch");

    raw_ptr->paintRect(1024, 576, 1024, 576, 210, 50, 30);
    raw_ptr->setCaptureOverrideDamage({3072, 1728, 512, 288});
    const auto updated = fitted->captureChanged(false);
    std::vector<DamageRect> rects;
    require(fitted->changedRects(rects) && rects.size() == 2, "scaled sub-rect bootstrap must preserve both original and new damage");
    const int cx = int(int64_t(1536) * dims.first / 5120);
    const int cy = int(int64_t(864) * dims.second / 2880);
    const bool covers_original = (rects[0].x <= cx && cx < rects[0].x + rects[0].width &&
                                  rects[0].y <= cy && cy < rects[0].y + rects[0].height);
    require(covers_original, "original sub-rect damage was lost during shadow bootstrap");
    const uint8_t* px = updated.data + size_t(cy) * size_t(updated.stride) + size_t(cx) * 4u;
    require(px[0] == 210 && px[1] == 50 && px[2] == 30, "scaled sub-rect center pixel mismatch");
    require(updated.data[0] == 40 && updated.data[1] == 120 && updated.data[2] == 200, "untouched pixel corrupted");

    const auto cur = fitted->cursor(true);
    require(cur && cur->width < 32 && cur->height < 32 && cur->xhot < cur->width && cur->yhot < cur->height,
            "scaled cursor dimensions/hotspot mismatch");
  }

  std::puts("surface budget and scaler checks passed");
  return 0;
}
