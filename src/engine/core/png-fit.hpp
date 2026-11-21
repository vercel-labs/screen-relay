#pragma once

#include "capture-source.hpp"
#include "image-scale.hpp"
#include <zlib.h>
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace relay {

/** Explicit outcome of fitting an RGB24 PNG screenshot into the wire size cap. */
enum class PngFitState : uint8_t {
  encoded_fast,
  encoded_compact,
  encoded_scaled,
  failed,
};

/** Returns a stable lowercase name for a PngFitState value. */
inline const char* pngFitStateName(PngFitState state) {
  switch (state) {
    case PngFitState::encoded_fast: return "encoded_fast";
    case PngFitState::encoded_compact: return "encoded_compact";
    case PngFitState::encoded_scaled: return "encoded_scaled";
    case PngFitState::failed: return "failed";
  }
  return "unknown";
}

/** Result of encoding a frame into a valid PNG bounded by max_bytes. */
struct PngFitResult {
  PngFitState state = PngFitState::failed;
  int width = 0;
  int height = 0;
  std::vector<uint8_t> png;
  std::string error;

  bool ok() const { return state != PngFitState::failed; }
};

namespace png_detail {

inline void append32(std::vector<uint8_t>& bytes, uint32_t value) {
  bytes.push_back(uint8_t(value >> 24));
  bytes.push_back(uint8_t(value >> 16));
  bytes.push_back(uint8_t(value >> 8));
  bytes.push_back(uint8_t(value));
}

inline void appendChunk(std::vector<uint8_t>& bytes, const char* type, const uint8_t* data, size_t size) {
  append32(bytes, static_cast<uint32_t>(size));
  const size_t start = bytes.size();
  bytes.insert(bytes.end(), type, type + 4);
  if (size) bytes.insert(bytes.end(), data, data + size);
  append32(bytes, static_cast<uint32_t>(crc32(0, bytes.data() + start, uInt(size + 4))));
}

inline uint8_t paethPredictor(int a, int b, int c) {
  const int p = a + b - c;
  const int pa = std::abs(p - a);
  const int pb = std::abs(p - b);
  const int pc = std::abs(p - c);
  if (pa <= pb && pa <= pc) return uint8_t(a);
  return pb <= pc ? uint8_t(b) : uint8_t(c);
}

inline void buildAdaptiveFilteredRgb(const uint8_t* data, int stride, int width, int height,
                                     PixelFormat format, std::vector<uint8_t>& filtered) {
  const size_t rgb_row = size_t(width) * 3u;
  const size_t out_row = rgb_row + 1u;
  filtered.resize(size_t(height) * out_row);
  std::vector<uint8_t> prev(rgb_row, 0);
  std::vector<uint8_t> curr(rgb_row, 0);
  std::vector<uint8_t> sub_buf(rgb_row);
  std::vector<uint8_t> up_buf(rgb_row);
  std::vector<uint8_t> paeth_buf(rgb_row);

  const int r_off = format == PixelFormat::BGRA ? 2 : 1;
  const int g_off = format == PixelFormat::BGRA ? 1 : 2;
  const int b_off = format == PixelFormat::BGRA ? 0 : 3;

  for (int y = 0; y < height; ++y) {
    const uint8_t* src = data + size_t(y) * size_t(stride);
    for (int x = 0; x < width; ++x) {
      curr[size_t(x) * 3u] = src[size_t(x) * 4u + size_t(r_off)];
      curr[size_t(x) * 3u + 1u] = src[size_t(x) * 4u + size_t(g_off)];
      curr[size_t(x) * 3u + 2u] = src[size_t(x) * 4u + size_t(b_off)];
    }

    uint64_t sad_none = 0, sad_sub = 0, sad_up = 0, sad_paeth = 0;
    for (size_t i = 0; i < rgb_row; ++i) {
      const int x = curr[i];
      const int a = i >= 3 ? curr[i - 3] : 0;
      const int b = prev[i];
      const int c = i >= 3 ? prev[i - 3] : 0;
      const uint8_t v_none = uint8_t(x);
      const uint8_t v_sub = uint8_t((x - a) & 0xff);
      const uint8_t v_up = uint8_t((x - b) & 0xff);
      const uint8_t v_paeth = uint8_t((x - paethPredictor(a, b, c)) & 0xff);
      sub_buf[i] = v_sub;
      up_buf[i] = v_up;
      paeth_buf[i] = v_paeth;
      sad_none += uint64_t(std::abs(int(int8_t(v_none))));
      sad_sub += uint64_t(std::abs(int(int8_t(v_sub))));
      sad_up += uint64_t(std::abs(int(int8_t(v_up))));
      sad_paeth += uint64_t(std::abs(int(int8_t(v_paeth))));
    }

    uint8_t* dst = filtered.data() + size_t(y) * out_row;
    uint8_t best_type = 0;
    const uint8_t* best_data = curr.data();
    uint64_t best_sad = sad_none;
    if (sad_sub < best_sad) { best_sad = sad_sub; best_type = 1; best_data = sub_buf.data(); }
    if (sad_up < best_sad) { best_sad = sad_up; best_type = 2; best_data = up_buf.data(); }
    if (sad_paeth < best_sad) { best_type = 4; best_data = paeth_buf.data(); }
    dst[0] = best_type;
    std::memcpy(dst + 1, best_data, rgb_row);
    std::swap(prev, curr);
  }
}

inline bool compressFilteredToPng(const std::vector<uint8_t>& filtered, int width, int height,
                                  int level, std::vector<uint8_t>& out, std::string& error) {
  uLongf compressed_size = compressBound(uLong(filtered.size()));
  std::vector<uint8_t> compressed(compressed_size);
  if (compress2(compressed.data(), &compressed_size, filtered.data(), uLong(filtered.size()), level) != Z_OK) {
    error = "PNG encode failed";
    return false;
  }
  std::vector<uint8_t> header;
  append32(header, uint32_t(width));
  append32(header, uint32_t(height));
  header.insert(header.end(), {8, 2, 0, 0, 0});
  out.clear();
  out.reserve(size_t(compressed_size) + 64u);
  out.insert(out.end(), {137, 80, 78, 71, 13, 10, 26, 10});
  appendChunk(out, "IHDR", header.data(), header.size());
  appendChunk(out, "IDAT", compressed.data(), size_t(compressed_size));
  appendChunk(out, "IEND", nullptr, 0);
  return true;
}

}  // namespace png_detail

/** Encodes a BGRA/ARGB frame into a PNG <= max_bytes via fast adaptive filter, compact zlib, then bounded downscale. */
inline PngFitResult encodeBoundedPng(const FrameView& view, size_t max_bytes = 8u * 1024u * 1024u) {
  PngFitResult result;
  if (!view.data || view.x != 0 || view.y != 0 || view.width <= 0 || view.height <= 0 ||
      view.stride < view.width * 4 || view.stride > view.width * 8 ||
      (view.format != PixelFormat::BGRA && view.format != PixelFormat::ARGB) ||
      max_bytes < 1024u) {
    result.error = "unsupported screenshot frame";
    return result;
  }

  std::vector<uint8_t> filtered;
  png_detail::buildAdaptiveFilteredRgb(view.data, view.stride, view.width, view.height, view.format, filtered);

  std::vector<uint8_t> png;
  std::string err;
  if (!png_detail::compressFilteredToPng(filtered, view.width, view.height, Z_DEFAULT_COMPRESSION, png, err)) {
    result.error = err;
    return result;
  }
  if (png.size() <= max_bytes) {
    result.state = PngFitState::encoded_fast;
    result.width = view.width;
    result.height = view.height;
    result.png = std::move(png);
    return result;
  }

  if (!png_detail::compressFilteredToPng(filtered, view.width, view.height, Z_BEST_COMPRESSION, png, err)) {
    result.error = err;
    return result;
  }
  if (png.size() <= max_bytes) {
    result.state = PngFitState::encoded_compact;
    result.width = view.width;
    result.height = view.height;
    result.png = std::move(png);
    return result;
  }

  int cur_w = view.width;
  int cur_h = view.height;
  size_t last_size = png.size();
  std::vector<uint8_t> scaled_rgba;
  for (int attempt = 0; attempt < 4; ++attempt) {
    const double ratio = std::clamp(std::sqrt(double(max_bytes) * 0.85 / double(last_size)), 0.35, 0.85);
    int next_w = std::max(min_frame_width, int(std::floor(double(cur_w) * ratio)) & ~1);
    int next_h = std::max(min_frame_height, int(std::floor(double(cur_h) * ratio)) & ~1);
    if (cur_w > min_frame_width && next_w >= cur_w) next_w = std::max(min_frame_width, (cur_w - 2) & ~1);
    if (cur_h > min_frame_height && next_h >= cur_h) next_h = std::max(min_frame_height, (cur_h - 2) & ~1);
    if (next_w == cur_w && next_h == cur_h) break;
    cur_w = next_w;
    cur_h = next_h;

    scaled_rgba.resize(size_t(cur_w) * size_t(cur_h) * 4u);
    scaleRgbaFrame(view.data, view.stride, view.width, view.height, scaled_rgba.data(), cur_w * 4, cur_w, cur_h);
    png_detail::buildAdaptiveFilteredRgb(scaled_rgba.data(), cur_w * 4, cur_w, cur_h, view.format, filtered);
    const int level = (attempt == 3 || (cur_w <= min_frame_width && cur_h <= min_frame_height))
        ? Z_BEST_COMPRESSION
        : Z_DEFAULT_COMPRESSION;
    if (!png_detail::compressFilteredToPng(filtered, cur_w, cur_h, level, png, err)) {
      result.error = err;
      return result;
    }
    if (png.size() <= max_bytes) {
      result.state = PngFitState::encoded_scaled;
      result.width = cur_w;
      result.height = cur_h;
      result.png = std::move(png);
      return result;
    }
    last_size = png.size();
  }

  result.error = max_bytes == 8u * 1024u * 1024u
      ? "PNG output exceeds 8 MiB"
      : "PNG output exceeds " + std::to_string(max_bytes) + " bytes";
  return result;
}

}  // namespace relay
