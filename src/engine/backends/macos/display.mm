#include "backends/macos/display.hpp"
#include "core/capture-source.hpp"
#include "core/surface-budget.hpp"
#include <charconv>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace relay {
namespace macos {
namespace {
std::string chosen;
unsigned target_fps = 60;
}
Display findDisplay() {
  uint32_t count = 0;
  if (CGGetOnlineDisplayList(0, nullptr, &count) != kCGErrorSuccess)
    throw std::runtime_error("Cannot list online displays");
  std::vector<CGDirectDisplayID> displays(count);
  if (count && CGGetOnlineDisplayList(count, displays.data(), &count) != kCGErrorSuccess)
    throw std::runtime_error("Cannot list online displays");
  displays.resize(count);
  CGDirectDisplayID selected = CGMainDisplayID();
  bool valid = true;
  if (!chosen.empty()) {
    const auto result = std::from_chars(chosen.data(), chosen.data() + chosen.size(), selected);
    valid = result.ec == std::errc{} && result.ptr == chosen.data() + chosen.size();
  }
  std::string names;
  for (const auto id : displays) {
    const CGRect bounds = CGDisplayBounds(id);
    names += (names.empty() ? "" : ", ") + std::to_string(id) + " (" +
             std::to_string(int(bounds.size.width)) + "x" + std::to_string(int(bounds.size.height)) + " points)";
    if (valid && id == selected) {
      int width = int(bounds.size.width), height = int(bounds.size.height);
      if (CGDisplayModeRef mode = CGDisplayCopyDisplayMode(id)) {
        width = int(CGDisplayModeGetPixelWidth(mode));
        height = int(CGDisplayModeGetPixelHeight(mode));
        CGDisplayModeRelease(mode);
      }
      const SurfacePlan plan = planSurface(width, height, SurfaceBudget::forFps(target_fps), SurfaceScaleMode::exact);
      if (!plan.ok()) {
        throw std::runtime_error("Unsupported display size " + std::to_string(width) + "x" +
                                 std::to_string(height) + " for H.264 level 5.2 at " +
                                 std::to_string(target_fps) + " fps");
      }
      return {id, bounds, width, height, plan.stream_width, plan.stream_height};
    }
  }
  if (names.empty()) names = "none";
  throw std::runtime_error((chosen.empty() ? "Main display not found" : "Display " + chosen + " not found") +
                           "; online displays: " + names);
}
/// Checks screen capture and event posting permissions, requests each missing one once, and validates --output.
bool initializeNativeBackend(const std::string& output, unsigned fps) {
  chosen = output;
  target_fps = fps ? fps : 60u;
  const bool screen = CGPreflightScreenCaptureAccess();
  const bool input = CGPreflightPostEventAccess();
  if (!screen) {
    static std::once_flag once;
    std::call_once(once, [] { CGRequestScreenCaptureAccess(); });
    std::cerr << "Screen capture permission is missing. In System Settings > Privacy & Security > Screen & System Audio Recording, "
                 "enable the app that started relay (for example, your terminal), then restart it.\n";
  }
  if (!input) {
    static std::once_flag once;
    std::call_once(once, [] { CGRequestPostEventAccess(); });
    std::cerr << "Accessibility permission is missing. In System Settings > Privacy & Security > Accessibility, "
                 "enable the app that started relay (for example, your terminal), then restart it.\n";
  }
  if (!screen || !input) return false;
  if (!chosen.empty()) {
    try { findDisplay(); }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return false; }
  }
  return true;
}
}
}
