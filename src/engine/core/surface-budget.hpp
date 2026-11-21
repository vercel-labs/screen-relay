#pragma once

#include "capture-source.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace relay {

/** Explicit outcome of fitting a display surface into the H.264 stream budget. */
enum class SurfaceFitState : uint8_t {
  native,
  clamped_even,
  scaled_axis_limit,
  scaled_level_budget,
  rejected,
};

/** Returns a stable lowercase name for a SurfaceFitState value. */
inline const char* surfaceFitStateName(SurfaceFitState state) {
  switch (state) {
    case SurfaceFitState::native: return "native";
    case SurfaceFitState::clamped_even: return "clamped_even";
    case SurfaceFitState::scaled_axis_limit: return "scaled_axis_limit";
    case SurfaceFitState::scaled_level_budget: return "scaled_level_budget";
    case SurfaceFitState::rejected: return "rejected";
  }
  return "unknown";
}

/** Scaling granularity supported by a capture backend. */
enum class SurfaceScaleMode : uint8_t {
  exact,
  power_of_two,
};

/** H.264 Level 5.2 decode and hardware-encoder surface envelope parameterized by frame rate. */
struct SurfaceBudget {
  static constexpr int default_max_dimension = 4096;
  static constexpr uint64_t level52_max_macroblocks = 36864;
  static constexpr uint64_t level52_max_macroblocks_per_sec = 2073600;
  static constexpr uint8_t level52_idc = 52;

  int max_dimension = default_max_dimension;
  uint64_t max_macroblocks = level52_max_macroblocks;
  uint64_t max_macroblocks_per_sec = level52_max_macroblocks_per_sec;
  unsigned fps = 60;
  uint8_t max_h264_level_idc = level52_idc;

  /** Returns the default H.264 Level 5.2 surface budget for the requested stream frame rate. */
  static constexpr SurfaceBudget forFps(unsigned target_fps) {
    SurfaceBudget budget;
    budget.fps = target_fps ? target_fps : 60u;
    return budget;
  }
};

/** Result of planning stream dimensions for one display surface under a SurfaceBudget. */
struct SurfacePlan {
  SurfaceFitState state = SurfaceFitState::rejected;
  int source_width = 0;
  int source_height = 0;
  int stream_width = 0;
  int stream_height = 0;
  unsigned shift = 0;
  uint64_t frame_macroblocks = 0;
  uint64_t macroblocks_per_sec = 0;
  uint8_t h264_level_idc = 0;

  bool ok() const { return state != SurfaceFitState::rejected; }
  bool scaled() const { return ok() && (stream_width != source_width || stream_height != source_height); }
};

/** Returns the number of 16x16 H.264 macroblocks covering a width x height frame. */
inline constexpr uint64_t surfaceMacroblocks(int width, int height) {
  if (width <= 0 || height <= 0) return 0;
  const uint64_t mb_w = (uint64_t(width) + 15u) / 16u;
  const uint64_t mb_h = (uint64_t(height) + 15u) / 16u;
  return mb_w * mb_h;
}

/** Returns the minimum ITU-T H.264 Annex A level_idc required for width x height at fps. */
inline constexpr uint8_t h264LevelIdc(int width, int height, unsigned fps) {
  if (width <= 0 || height <= 0) return 0;
  const uint64_t mb_w = (uint64_t(width) + 15u) / 16u;
  const uint64_t mb_h = (uint64_t(height) + 15u) / 16u;
  const uint64_t frame_mb = mb_w * mb_h;
  const uint64_t mbps = frame_mb * (fps ? uint64_t(fps) : 1u);
  const uint64_t max_axis = mb_w > mb_h ? mb_w : mb_h;

  struct Entry {
    uint8_t idc;
    uint64_t max_mbps;
    uint64_t max_fs;
    uint64_t max_axis_mbs;
  };
  constexpr Entry table[] = {
      {30, 40500, 1620, 113},
      {31, 108000, 3600, 169},
      {32, 216000, 5120, 202},
      {40, 245760, 8192, 256},
      {42, 522240, 8704, 263},
      {50, 589824, 22080, 420},
      {51, 983040, 36864, 543},
      {52, 2073600, 36864, 543},
      {60, 4177920, 139264, 1055},
      {61, 8355840, 139264, 1055},
      {62, 16711680, 139264, 1055},
  };
  for (const auto& entry : table) {
    if (frame_mb <= entry.max_fs && mbps <= entry.max_mbps && max_axis <= entry.max_axis_mbs) {
      return entry.idc;
    }
  }
  return 62;
}

/** Reports whether even width x height fits all axis, macroblock, macroblock-rate, and H.264 level bounds. */
inline constexpr bool fitsSurfaceBudget(int width, int height, const SurfaceBudget& budget) {
  if (width < min_frame_width || height < min_frame_height) return false;
  if (width > max_frame_width || height > max_frame_height) return false;
  if ((width & 1) || (height & 1)) return false;
  if (width > budget.max_dimension || height > budget.max_dimension) return false;
  const unsigned safe_fps = budget.fps ? budget.fps : 60u;
  const uint64_t frame_mb = surfaceMacroblocks(width, height);
  const uint64_t mbps = frame_mb * uint64_t(safe_fps);
  if (frame_mb > budget.max_macroblocks || mbps > budget.max_macroblocks_per_sec) return false;
  return h264LevelIdc(width, height, safe_fps) <= budget.max_h264_level_idc;
}

/** Plans even stream dimensions that fit budget using exact aspect-preserving scaling or power-of-two shifts. */
inline SurfacePlan planSurface(int source_width, int source_height, const SurfaceBudget& budget,
                               SurfaceScaleMode mode = SurfaceScaleMode::exact) {
  SurfacePlan plan;
  plan.source_width = source_width;
  plan.source_height = source_height;
  if (source_width < min_frame_width || source_height < min_frame_height) return plan;
  if (budget.max_dimension < min_frame_width || budget.max_dimension < min_frame_height) return plan;

  const unsigned safe_fps = budget.fps ? budget.fps : 60u;
  const int even_w = source_width & ~1;
  const int even_h = source_height & ~1;

  auto finalize = [&](SurfaceFitState state, int w, int h, unsigned shift) {
    plan.state = state;
    plan.stream_width = w;
    plan.stream_height = h;
    plan.shift = shift;
    plan.frame_macroblocks = surfaceMacroblocks(w, h);
    plan.macroblocks_per_sec = plan.frame_macroblocks * uint64_t(safe_fps);
    plan.h264_level_idc = h264LevelIdc(w, h, safe_fps);
    return plan;
  };

  if (fitsSurfaceBudget(even_w, even_h, budget)) {
    const SurfaceFitState state = (even_w == source_width && even_h == source_height)
        ? SurfaceFitState::native
        : SurfaceFitState::clamped_even;
    return finalize(state, even_w, even_h, 0);
  }

  const uint64_t even_mb = surfaceMacroblocks(even_w, even_h);
  const uint64_t even_mbps = even_mb * uint64_t(safe_fps);
  const bool level_exceeded = even_mb > budget.max_macroblocks ||
                              even_mbps > budget.max_macroblocks_per_sec ||
                              h264LevelIdc(even_w, even_h, safe_fps) > budget.max_h264_level_idc;
  const SurfaceFitState scaled_state = level_exceeded
      ? SurfaceFitState::scaled_level_budget
      : SurfaceFitState::scaled_axis_limit;

  if (mode == SurfaceScaleMode::power_of_two) {
    for (unsigned shift = 1; shift <= 8; ++shift) {
      const int w = (source_width >> shift) & ~1;
      const int h = (source_height >> shift) & ~1;
      if (w < min_frame_width || h < min_frame_height) return plan;
      if (fitsSurfaceBudget(w, h, budget)) {
        return finalize(scaled_state, w, h, shift);
      }
    }
    return plan;
  }

  const int axis_cap = std::min({budget.max_dimension, max_frame_width, max_frame_height});
  const uint64_t effective_max_mb = std::min(budget.max_macroblocks, budget.max_macroblocks_per_sec / uint64_t(safe_fps));
  if (!effective_max_mb) return plan;

  double scale = 1.0;
  if (source_width > axis_cap) scale = std::min(scale, double(axis_cap) / double(source_width));
  if (source_height > axis_cap) scale = std::min(scale, double(axis_cap) / double(source_height));
  const double pixel_budget = double(effective_max_mb) * 256.0;
  const double source_pixels = double(source_width) * double(source_height);
  if (source_pixels > pixel_budget) {
    scale = std::min(scale, std::sqrt(pixel_budget / source_pixels));
  }

  int w = std::min(axis_cap & ~1, int(std::floor(double(source_width) * scale)) & ~1);
  int h = std::min(axis_cap & ~1, int(std::floor(double(source_height) * scale)) & ~1);
  if (w < min_frame_width || h < min_frame_height) return plan;

  const double target_aspect = double(source_width) / double(source_height);
  while (!fitsSurfaceBudget(w, h, budget)) {
    const bool can_w = w - 2 >= min_frame_width;
    const bool can_h = h - 2 >= min_frame_height;
    if (!can_w && !can_h) return plan;
    if (can_w && can_h) {
      const double err_w = std::abs(double(w - 2) / double(h) - target_aspect);
      const double err_h = std::abs(double(w) / double(h - 2) - target_aspect);
      if (err_w <= err_h) w -= 2;
      else h -= 2;
    } else if (can_w) {
      w -= 2;
    } else {
      h -= 2;
    }
  }
  return finalize(scaled_state, w, h, 0);
}

}  // namespace relay
