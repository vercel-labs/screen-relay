#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "wait.hpp"

namespace relay {
constexpr int min_frame_width = 320, max_frame_width = 16384;
constexpr int min_frame_height = 240, max_frame_height = 16384;

/** Throws unless width and height are even and inside the supported root size limits. */
inline void requireSurfaceSize(int width, int height) {
  if (width < min_frame_width || width > max_frame_width || height < min_frame_height ||
      height > max_frame_height || (width & 1) || (height & 1))
    throw std::runtime_error("Unsupported root size " + std::to_string(width) + "x" + std::to_string(height) +
                             ": width must be even and " + std::to_string(min_frame_width) + " to " +
                             std::to_string(max_frame_width) + ", height even and " +
                             std::to_string(min_frame_height) + " to " + std::to_string(max_frame_height));
}

enum class PixelFormat { BGRA, ARGB };

/** Frame returned by CaptureSource: CPU pixels and/or an OS GPU handle valid until the next capture. */
struct FrameView {
  const uint8_t* data;
  int stride, width, height;
  PixelFormat format;
  int x = 0, y = 0;
  void* native_handle = nullptr;
};

struct DamageRect { int x, y, width, height; };

/** Straight-alpha RGBA cursor image; empty dimensions explicitly restore the local arrow. */
struct CursorImage {
  static constexpr unsigned max_extent = 256;
  uint16_t width = 0, height = 0, xhot = 0, yhot = 0;
  std::vector<uint8_t> rgba;
};

/** Platform capture source providing damage wakeups, pixels or native GPU surfaces, and optional cursor images. */
class CaptureSource {
 public:
  virtual ~CaptureSource() = default;
  /** Becomes ready when the source may have new damage; see WaitHandle. */
  virtual WaitHandle fd() const = 0;
  /** Pixel size of every full frame this source captures. */
  virtual std::pair<int, int> dimensions() const = 0;
  virtual bool drainDamage() = 0;
  virtual PixelFormat pixelFormat() const = 0;
  virtual FrameView capture() = 0;
  /** Captures only the damage region when full is false; a view may still cover the whole frame. */
  virtual FrameView captureChanged(bool /*full*/) { return capture(); }
  /** Captures a frame preferring a zero-copy native handle when the source supports it. */
  virtual FrameView captureNative(bool full) { return captureChanged(full); }
  /** Releases a native handle returned by captureNative once the encoder has accepted or rejected it. */
  virtual void releaseNative(void* /*handle*/) {}
  /** Fills the pixel rectangles changed since the previous capture(); false means treat the whole frame as changed. */
  virtual bool changedRects(std::vector<DamageRect>& /*rects*/) { return false; }
  virtual bool cursorSupported() const { return false; }
  /** Returns the latest cursor image when changed or forced; called on the capture owner thread. */
  virtual std::optional<CursorImage> cursor(bool /*force*/) { return std::nullopt; }
};

using CaptureSourceFactory = std::function<std::unique_ptr<CaptureSource>()>;
}
