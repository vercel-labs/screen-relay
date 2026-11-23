#pragma once

#include "capture-source.hpp"
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace relay {

/** Precomputed integer box-filter source pixel ranges for scaling one 4-byte-per-pixel surface. */
struct RgbaScaleTable {
  int src_width = 0;
  int src_height = 0;
  int dst_width = 0;
  int dst_height = 0;
  std::vector<int> x0;
  std::vector<int> x1;
  std::vector<int> y0;
  std::vector<int> y1;

  void build(int sw, int sh, int dw, int dh) {
    if (src_width == sw && src_height == sh && dst_width == dw && dst_height == dh) return;
    src_width = sw;
    src_height = sh;
    dst_width = dw;
    dst_height = dh;
    x0.resize(size_t(dw));
    x1.resize(size_t(dw));
    y0.resize(size_t(dh));
    y1.resize(size_t(dh));
    for (int dx = 0; dx < dw; ++dx) {
      const int start = int(int64_t(dx) * sw / dw);
      const int end = std::min(sw, std::max(start + 1, int((int64_t(dx + 1) * sw + dw - 1) / dw)));
      x0[size_t(dx)] = start;
      x1[size_t(dx)] = end;
    }
    for (int dy = 0; dy < dh; ++dy) {
      const int start = int(int64_t(dy) * sh / dh);
      const int end = std::min(sh, std::max(start + 1, int((int64_t(dy + 1) * sh + dh - 1) / dh)));
      y0[size_t(dy)] = start;
      y1[size_t(dy)] = end;
    }
  }
};

/** Area-averages a rectangular destination region of a 4-byte-per-pixel BGRA/ARGB surface. */
inline void scaleRgbaRect(const uint8_t* src, int src_stride, const RgbaScaleTable& table,
                          uint8_t* dst, int dst_stride, const DamageRect& rect) {
  const int dx0 = std::clamp(rect.x, 0, table.dst_width);
  const int dy0 = std::clamp(rect.y, 0, table.dst_height);
  const int dx1 = std::clamp(rect.x + rect.width, dx0, table.dst_width);
  const int dy1 = std::clamp(rect.y + rect.height, dy0, table.dst_height);
  for (int dy = dy0; dy < dy1; ++dy) {
    const int sy0 = table.y0[size_t(dy)];
    const int sy1 = table.y1[size_t(dy)];
    uint8_t* out_row = dst + size_t(dy) * size_t(dst_stride);
    for (int dx = dx0; dx < dx1; ++dx) {
      const int sx0 = table.x0[size_t(dx)];
      const int sx1 = table.x1[size_t(dx)];
      uint32_t c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      uint32_t count = 0;
      for (int sy = sy0; sy < sy1; ++sy) {
        const uint8_t* in_row = src + size_t(sy) * size_t(src_stride) + size_t(sx0) * 4u;
        for (int sx = sx0; sx < sx1; ++sx, in_row += 4) {
          c0 += in_row[0];
          c1 += in_row[1];
          c2 += in_row[2];
          c3 += in_row[3];
          ++count;
        }
      }
      if (!count) continue;
      const uint32_t half = count / 2u;
      uint8_t* out = out_row + size_t(dx) * 4u;
      out[0] = uint8_t((c0 + half) / count);
      out[1] = uint8_t((c1 + half) / count);
      out[2] = uint8_t((c2 + half) / count);
      out[3] = uint8_t((c3 + half) / count);
    }
  }
}

/** Scales an entire 4-byte-per-pixel BGRA/ARGB frame into dst using exact area averaging. */
inline void scaleRgbaFrame(const uint8_t* src, int src_stride, int src_w, int src_h,
                           uint8_t* dst, int dst_stride, int dst_w, int dst_h) {
  RgbaScaleTable table;
  table.build(src_w, src_h, dst_w, dst_h);
  scaleRgbaRect(src, src_stride, table, dst, dst_stride, {0, 0, dst_w, dst_h});
}

/** Area-averages a tightly packed straight-alpha RGBA image, weighting color by alpha so transparent pixels do not darken edges. */
inline void scaleStraightAlphaRgba(const uint8_t* src, int src_w, int src_h, uint8_t* dst, int dst_w, int dst_h) {
  RgbaScaleTable table;
  table.build(src_w, src_h, dst_w, dst_h);
  for (int dy = 0; dy < dst_h; ++dy) {
    for (int dx = 0; dx < dst_w; ++dx) {
      uint32_t c0 = 0, c1 = 0, c2 = 0, alpha = 0, count = 0;
      for (int sy = table.y0[size_t(dy)]; sy < table.y1[size_t(dy)]; ++sy) {
        const uint8_t* in = src + (size_t(sy) * size_t(src_w) + size_t(table.x0[size_t(dx)])) * 4u;
        for (int sx = table.x0[size_t(dx)]; sx < table.x1[size_t(dx)]; ++sx, in += 4) {
          c0 += uint32_t(in[0]) * in[3];
          c1 += uint32_t(in[1]) * in[3];
          c2 += uint32_t(in[2]) * in[3];
          alpha += in[3];
          ++count;
        }
      }
      uint8_t* out = dst + (size_t(dy) * size_t(dst_w) + size_t(dx)) * 4u;
      out[0] = alpha ? uint8_t((c0 + alpha / 2u) / alpha) : 0;
      out[1] = alpha ? uint8_t((c1 + alpha / 2u) / alpha) : 0;
      out[2] = alpha ? uint8_t((c2 + alpha / 2u) / alpha) : 0;
      out[3] = uint8_t((alpha + count / 2u) / count);
    }
  }
}

/** Maps a source-space damage rectangle into an even-aligned destination rectangle covering all affected pixels. */
inline DamageRect mapDamageRect(const DamageRect& src_rect, int src_w, int src_h, int dst_w, int dst_h) {
  const int sx0 = std::clamp(src_rect.x, 0, src_w);
  const int sy0 = std::clamp(src_rect.y, 0, src_h);
  const int sx1 = std::clamp(src_rect.x + src_rect.width, sx0, src_w);
  const int sy1 = std::clamp(src_rect.y + src_rect.height, sy0, src_h);
  if (sx1 <= sx0 || sy1 <= sy0) return {0, 0, 0, 0};
  const int dx0 = std::max(0, (int(int64_t(sx0) * dst_w / src_w)) & ~1);
  const int dy0 = std::max(0, (int(int64_t(sy0) * dst_h / src_h)) & ~1);
  const int dx1 = std::min(dst_w, (int((int64_t(sx1) * dst_w + src_w - 1) / src_w) + 1) & ~1);
  const int dy1 = std::min(dst_h, (int((int64_t(sy1) * dst_h + src_h - 1) / src_h) + 1) & ~1);
  return {dx0, dy0, std::max(0, dx1 - dx0), std::max(0, dy1 - dy0)};
}

}  // namespace relay
