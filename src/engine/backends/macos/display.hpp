#pragma once
#include <CoreGraphics/CoreGraphics.h>

namespace relay {
namespace macos {
/// A display with global bounds and a stream size based on native pixels when available.
struct Display {
  /// CoreGraphics display ID (CGDirectDisplayID).
  CGDirectDisplayID id;
  /// Display bounds in global points, origin at the top-left of the main display.
  CGRect bounds;
  /// Native backing-store width in pixels before stream-budget scaling.
  int native_width;
  /// Native backing-store height in pixels before stream-budget scaling.
  int native_height;
  /// Stream width in pixels, even and within the H.264 Level 5.2 surface budget.
  int width;
  /// Stream height in pixels, even and within the H.264 Level 5.2 surface budget.
  int height;
};
/// Finds the display chosen with --output by CGDirectDisplayID, or the main display when none was chosen.
Display findDisplay();
}
}
