#include "core/png-fit.hpp"
#include <zlib.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {
void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "png-fit-test failed: %s\n", message);
    std::exit(1);
  }
}

uint32_t read32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

struct DecodedPng {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgb;
};

DecodedPng decodePng(const std::vector<uint8_t>& png) {
  static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  require(png.size() >= 33 && std::memcmp(png.data(), sig, 8) == 0, "invalid PNG signature");
  DecodedPng out;
  std::vector<uint8_t> idat;
  bool saw_ihdr = false, saw_iend = false;
  size_t pos = 8;
  while (pos + 12 <= png.size()) {
    const uint32_t len = read32(png.data() + pos);
    require(pos + 12 + len <= png.size(), "truncated PNG chunk");
    const uint8_t* type = png.data() + pos + 4;
    const uint8_t* data = png.data() + pos + 8;
    const uint32_t expected_crc = read32(data + len);
    const uint32_t actual_crc = uint32_t(crc32(0, type, uInt(len + 4)));
    require(expected_crc == actual_crc, "PNG chunk CRC mismatch");
    if (std::memcmp(type, "IHDR", 4) == 0) {
      require(len == 13, "invalid IHDR length");
      out.width = int(read32(data));
      out.height = int(read32(data + 4));
      require(data[8] == 8 && data[9] == 2 && data[10] == 0 && data[11] == 0 && data[12] == 0, "unexpected IHDR format");
      saw_ihdr = true;
    } else if (std::memcmp(type, "IDAT", 4) == 0) {
      idat.insert(idat.end(), data, data + len);
    } else if (std::memcmp(type, "IEND", 4) == 0) {
      saw_iend = true;
      break;
    }
    pos += 12 + len;
  }
  require(saw_ihdr && saw_iend && !idat.empty(), "missing PNG chunks");

  const size_t row_rgb = size_t(out.width) * 3u;
  const size_t raw_size = size_t(out.height) * (row_rgb + 1u);
  std::vector<uint8_t> raw(raw_size);
  uLongf dest_len = uLongf(raw.size());
  require(uncompress(raw.data(), &dest_len, idat.data(), uLong(idat.size())) == Z_OK && dest_len == raw_size,
          "zlib uncompress failed");

  out.rgb.resize(size_t(out.height) * row_rgb);
  for (int y = 0; y < out.height; ++y) {
    const uint8_t* src = raw.data() + size_t(y) * (row_rgb + 1u);
    const uint8_t filter = src[0];
    uint8_t* dst = out.rgb.data() + size_t(y) * row_rgb;
    const uint8_t* prev = y > 0 ? out.rgb.data() + size_t(y - 1) * row_rgb : nullptr;
    for (size_t i = 0; i < row_rgb; ++i) {
      const int x = src[i + 1];
      const int a = i >= 3 ? dst[i - 3] : 0;
      const int b = prev ? prev[i] : 0;
      const int c = (prev && i >= 3) ? prev[i - 3] : 0;
      if (filter == 0) dst[i] = uint8_t(x);
      else if (filter == 1) dst[i] = uint8_t((x + a) & 0xff);
      else if (filter == 2) dst[i] = uint8_t((x + b) & 0xff);
      else if (filter == 4) dst[i] = uint8_t((x + relay::png_detail::paethPredictor(a, b, c)) & 0xff);
      else require(false, "unexpected PNG filter byte");
    }
  }
  return out;
}

size_t filterZeroSize(const relay::FrameView& view) {
  const size_t row = size_t(view.width) * 3u + 1u;
  std::vector<uint8_t> raw(size_t(view.height) * row, 0);
  for (int y = 0; y < view.height; ++y) {
    const uint8_t* s = view.data + size_t(y) * size_t(view.stride);
    uint8_t* t = raw.data() + size_t(y) * row + 1u;
    for (int x = 0; x < view.width; ++x) {
      t[size_t(x) * 3u] = s[size_t(x) * 4u + 2];
      t[size_t(x) * 3u + 1] = s[size_t(x) * 4u + 1];
      t[size_t(x) * 3u + 2] = s[size_t(x) * 4u];
    }
  }
  uLongf out = compressBound(uLong(raw.size()));
  std::vector<uint8_t> buf(out);
  require(compress2(buf.data(), &out, raw.data(), uLong(raw.size()), Z_DEFAULT_COMPRESSION) == Z_OK, "baseline zlib failed");
  return size_t(out);
}
}  // namespace

int main() {
  using namespace relay;

  {
    const int w = 1280, h = 720;
    std::vector<uint8_t> bgra(size_t(w) * size_t(h) * 4u);
    for (int y = 0; y < h; ++y) {
      for (int x = 0; x < w; ++x) {
        uint8_t* p = bgra.data() + (size_t(y) * size_t(w) + size_t(x)) * 4u;
        p[0] = uint8_t((x * 3 + y * 5) & 0xff);
        p[1] = uint8_t((x * 7 + y * 2) & 0xff);
        p[2] = uint8_t((x + y * 4) & 0xff);
        p[3] = 255;
      }
    }
    const FrameView view{bgra.data(), w * 4, w, h, PixelFormat::BGRA, 0, 0};
    const auto res = encodeBoundedPng(view);
    require(res.ok() && res.state == PngFitState::encoded_fast, "gradient frame should encode in fast state");
    require(res.width == w && res.height == h && res.png.size() <= 8u * 1024u * 1024u, "gradient dimensions/size mismatch");
    require(res.png.size() < filterZeroSize(view), "adaptive filtering should beat filter-0 on smooth gradients");
    const auto decoded = decodePng(res.png);
    require(decoded.width == w && decoded.height == h, "decoded gradient dimensions mismatch");
    for (int y = 0; y < h; y += 17) {
      for (int x = 0; x < w; x += 29) {
        const uint8_t* src = bgra.data() + (size_t(y) * size_t(w) + size_t(x)) * 4u;
        const uint8_t* got = decoded.rgb.data() + (size_t(y) * size_t(w) + size_t(x)) * 3u;
        require(got[0] == src[2] && got[1] == src[1] && got[2] == src[0], "BGRA round-trip pixel mismatch");
      }
    }
  }

  {
    const int w = 640, h = 360;
    std::vector<uint8_t> argb(size_t(w) * size_t(h) * 4u);
    for (int y = 0; y < h; ++y) {
      for (int x = 0; x < w; ++x) {
        uint8_t* p = argb.data() + (size_t(y) * size_t(w) + size_t(x)) * 4u;
        p[0] = 255;
        p[1] = uint8_t(x & 0xff);
        p[2] = uint8_t(y & 0xff);
        p[3] = uint8_t((x ^ y) & 0xff);
      }
    }
    const FrameView view{argb.data(), w * 4, w, h, PixelFormat::ARGB, 0, 0};
    const auto res = encodeBoundedPng(view);
    require(res.ok() && res.state == PngFitState::encoded_fast, "ARGB encode failed");
    const auto decoded = decodePng(res.png);
    const uint8_t* got = decoded.rgb.data() + (size_t(100) * size_t(w) + size_t(200)) * 3u;
    require(got[0] == 200 && got[1] == 100 && got[2] == (200 ^ 100), "ARGB channel order mismatch");
  }

  {
    const int w = 3840, h = 2160;
    std::vector<uint8_t> noise(size_t(w) * size_t(h) * 4u);
    uint64_t state = 0x9e3779b97f4a7c15ULL;
    for (size_t i = 0; i < noise.size(); i += 4) {
      state ^= state >> 12;
      state ^= state << 25;
      state ^= state >> 27;
      const uint64_t v = state * 0x2545F4914F6CDD1DULL;
      noise[i] = uint8_t(v & 0xff);
      noise[i + 1] = uint8_t((v >> 8) & 0xff);
      noise[i + 2] = uint8_t((v >> 16) & 0xff);
      noise[i + 3] = 255;
    }
    const FrameView view{noise.data(), w * 4, w, h, PixelFormat::BGRA, 0, 0};
    const auto res = encodeBoundedPng(view, 8u * 1024u * 1024u);
    require(res.ok() && res.state == PngFitState::encoded_scaled, "4K high-entropy noise must scale to fit 8 MiB");
    require(res.png.size() <= 8u * 1024u * 1024u, "scaled PNG exceeded 8 MiB");
    require(res.width < w && res.height < h && (res.width & 1) == 0 && (res.height & 1) == 0,
            "scaled PNG dimensions invalid");
    const auto decoded = decodePng(res.png);
    require(decoded.width == res.width && decoded.height == res.height, "decoded scaled PNG mismatch");
  }

  std::puts("png fit state machine checks passed");
  return 0;
}
