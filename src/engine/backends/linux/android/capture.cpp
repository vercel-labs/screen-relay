#include "core/capture-source.hpp"
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/timerfd.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
#if defined(__AVX2__)
#include <immintrin.h>
#elif defined(__ARM_NEON)
#include <arm_neon.h>
#endif

namespace relay::android {
namespace {

inline void swizzleRgbaToBgra(const uint8_t* src, uint8_t* dst, size_t pixels) {
  size_t i = 0;
#if defined(__AVX2__)
  const __m256i shuf = _mm256_setr_epi8(
      2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15,
      2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15);
  for (; i + 8 <= pixels; i += 8) {
    const __m256i v = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(src + i * 4));
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(dst + i * 4), _mm256_shuffle_epi8(v, shuf));
  }
#elif defined(__ARM_NEON)
  static constexpr uint8_t kIdx[16] = {2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15};
  const uint8x16_t idx = vld1q_u8(kIdx);
  for (; i + 4 <= pixels; i += 4) {
    const uint8x16_t v = vld1q_u8(src + i * 4);
    vst1q_u8(dst + i * 4, vqtbl1q_u8(v, idx));
  }
#endif
  const uint32_t* s32 = reinterpret_cast<const uint32_t*>(src);
  uint32_t* d32 = reinterpret_cast<uint32_t*>(dst);
  for (; i < pixels; ++i) {
    const uint32_t px = s32[i];
    d32[i] = (px & 0xFF00FF00u) | ((px & 0x00FF0000u) >> 16) | ((px & 0x000000FFu) << 16);
  }
}

uint64_t nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

inline uint64_t sampleFrameHash(const uint8_t* px, int w, int h) {
  uint64_t hash = 14695981039346656037ULL;
  const size_t stride = static_cast<size_t>(w) * 4;
  constexpr int kLines = 32;
  for (int k = 0; k < kLines; ++k) {
    const int y = (k * h) / kLines;
    const uint64_t* row = reinterpret_cast<const uint64_t*>(px + static_cast<size_t>(y) * stride);
    const size_t words = stride / 8;
    for (size_t x = 0; x < words; x += 4) {
      hash ^= row[x];
      hash *= 1099511628211ULL;
    }
  }
  return hash;
}

inline void waitForSwiftShaderStable(const uint8_t* px, int w, int h, uint64_t presented_ms) {
  const uint64_t start = nowMs();
  uint64_t prev_h = sampleFrameHash(px, w, h);
  for (int iter = 0; iter < 18; ++iter) {
    ::usleep(4000);
    const uint64_t cur_h = sampleFrameHash(px, w, h);
    if (cur_h == prev_h && (nowMs() - presented_ms) >= 16) {
      return;
    }
    prev_h = cur_h;
    if (nowMs() - start >= 85) return;
  }
}

std::pair<int, int> configuredSize() {
  int w = 720, h = 1520;
  if (const char* env = std::getenv("RELAY_ANDROID_SIZE")) {
    int pw = 0, ph = 0;
    if (std::sscanf(env, "%dx%d", &pw, &ph) == 2 && pw >= min_frame_width && ph >= min_frame_height) {
      w = pw & ~1;
      h = ph & ~1;
    }
  }
  return {w, h};
}

std::string configuredSock() {
  if (const char* env = std::getenv("RELAY_ANDROID_SOCK"); env && *env) return env;
  return "/tmp/ipc/hwcomposer.sock";
}

int configuredFps() {
  if (const char* env = std::getenv("SCREEN_RELAY_FPS")) {
    int f = std::atoi(env);
    if (f >= 15 && f <= 120) return f;
  }
  return 60;
}

struct MappedBuf {
  const uint8_t* ptr = nullptr;
  size_t sz = 0;
  int fd = -1;
};

class AndroidCaptureSource final : public CaptureSource {
 public:
  AndroidCaptureSource() {
    auto [w, h] = configuredSize();
    width_ = w;
    height_ = h;
    requireSurfaceSize(width_, height_);
    sock_path_ = configuredSock();
    const size_t bytes = static_cast<size_t>(width_) * height_ * 4;
    ready_buf_.resize(bytes, 0);
    front_buf_.resize(bytes, 0);

    tfd_ = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
    if (tfd_ < 0) throw std::runtime_error("timerfd_create failed");
    const long ns = 1000000000L / configuredFps();
    itimerspec ts{};
    ts.it_value.tv_nsec = ns;
    ts.it_interval.tv_nsec = ns;
    timerfd_settime(tfd_, 0, &ts, nullptr);

    worker_ = std::thread([this] { runSocket(); });
  }

  ~AndroidCaptureSource() override {
    stop_.store(true);
    if (sock_fd_ >= 0) ::shutdown(sock_fd_, SHUT_RDWR);
    if (worker_.joinable()) worker_.join();
    std::lock_guard<std::mutex> lock(mtx_);
    for (auto& [ino, mb] : cache_) {
      if (mb.ptr) ::munmap(const_cast<uint8_t*>(mb.ptr), mb.sz);
      if (mb.fd >= 0) ::close(mb.fd);
    }
    cache_.clear();
    if (tfd_ >= 0) ::close(tfd_);
  }

  WaitHandle fd() const override { return tfd_; }
  std::pair<int, int> dimensions() const override { return {width_, height_}; }
  PixelFormat pixelFormat() const override { return PixelFormat::BGRA; }

  bool drainDamage() override {
    uint64_t ticks = 0;
    const ssize_t n = ::read(tfd_, &ticks, sizeof(ticks));
    return n > 0 && ticks > 0;
  }

  FrameView capture() override {
    const size_t total = static_cast<size_t>(width_) * height_;
    std::lock_guard<std::mutex> lock(mtx_);
    // When animation settles (>35ms since last present), latch the latest buffer once
    // so the final resting frame is always displayed completely rendered (SwiftShader takes ~20-26ms).
    if (pending_settle_ && cur_px_ && (nowMs() - last_present_ms_ >= 35)) {
      swizzleRgbaToBgra(cur_px_, ready_buf_.data(), total);
      pending_settle_ = false;
    }
    std::memcpy(front_buf_.data(), ready_buf_.data(), front_buf_.size());
    return FrameView{front_buf_.data(), width_ * 4, width_, height_, PixelFormat::BGRA};
  }

 private:
  void runSocket() {
    const size_t total = static_cast<size_t>(width_) * height_;
    const size_t raw_sz = total * 4;
    std::vector<uint8_t> scratch(raw_sz);

    while (!stop_.load()) {
      int s = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
      if (s < 0) {
        ::usleep(100000);
        continue;
      }
      sockaddr_un sa{};
      sa.sun_family = AF_UNIX;
      std::strncpy(sa.sun_path, sock_path_.c_str(), sizeof(sa.sun_path) - 1);
      if (::connect(s, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) < 0) {
        ::close(s);
        ::usleep(100000);
        continue;
      }
      sock_fd_ = s;
      while (!stop_.load()) {
        char data[256];
        char cbuf[CMSG_SPACE(sizeof(int) * 8)];
        iovec iov{data, sizeof(data)};
        msghdr msg{};
        msg.msg_iov = &iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cbuf;
        msg.msg_controllen = sizeof(cbuf);

        const ssize_t n = ::recvmsg(s, &msg, 0);
        if (n <= 0) break;

        int fd = -1;
        for (cmsghdr* cm = CMSG_FIRSTHDR(&msg); cm; cm = CMSG_NXTHDR(&msg, cm)) {
          if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) {
            std::memcpy(&fd, CMSG_DATA(cm), sizeof(int));
            break;
          }
        }
        if (fd >= 0) {
          struct stat st{};
          if (::fstat(fd, &st) == 0 && static_cast<size_t>(st.st_size) >= raw_sz) {
            const uint64_t ino = static_cast<uint64_t>(st.st_ino);
            const uint8_t* px = nullptr;
            const uint8_t* prev_to_copy = nullptr;
            uint64_t prev_present_ms = 0;
            {
              std::lock_guard<std::mutex> lock(mtx_);
              auto it = cache_.find(ino);
              if (it != cache_.end()) {
                px = it->second.ptr;
                ::close(fd);
              } else {
                // Keep cache bounded to 6 buffers
                if (cache_.size() >= 6) {
                  for (auto& [k, mb] : cache_) {
                    if (mb.ptr) ::munmap(const_cast<uint8_t*>(mb.ptr), mb.sz);
                    if (mb.fd >= 0) ::close(mb.fd);
                  }
                  cache_.clear();
                  cur_px_ = nullptr;
                }
                void* mapped = ::mmap(nullptr, static_cast<size_t>(st.st_size), PROT_READ, MAP_SHARED, fd, 0);
                if (mapped != MAP_FAILED) {
                  px = static_cast<const uint8_t*>(mapped);
                  cache_[ino] = MappedBuf{px, static_cast<size_t>(st.st_size), fd};
                } else {
                  ::close(fd);
                }
              }
              if (px) {
                // Pipelined readout: cur_px_ (from the PREVIOUS present) is NOT yet cleared by
                // SurfaceFlinger because we haven't ACKed this present. Enforce a minimum settle
                // window since cur_px_ was presented so SwiftShader finishes every horizontal tile
                // band before we read it (eliminates barcode tearing during 60Hz Chromium scroll).
                if (cur_px_ && cur_px_ != px) {
                  prev_to_copy = cur_px_;
                  prev_present_ms = last_present_ms_;
                }
                cur_px_ = px;
                last_present_ms_ = nowMs();
                pending_settle_ = true;
              }
            }
            if (prev_to_copy) {
              waitForSwiftShaderStable(prev_to_copy, width_, height_, prev_present_ms);
              swizzleRgbaToBgra(prev_to_copy, scratch.data(), total);
              std::lock_guard<std::mutex> lock(mtx_);
              ready_buf_.swap(scratch);
            }
          } else {
            ::close(fd);
          }
        }
        const char ack = 1;
        (void)::send(s, &ack, 1, MSG_NOSIGNAL);
      }
      sock_fd_ = -1;
      ::close(s);
      if (!stop_.load()) ::usleep(100000);
    }
  }

  int width_ = 720, height_ = 1520;
  int tfd_ = -1;
  std::atomic<int> sock_fd_{-1};
  std::atomic<bool> stop_{false};
  std::string sock_path_;
  std::mutex mtx_;
  std::unordered_map<uint64_t, MappedBuf> cache_;
  const uint8_t* cur_px_ = nullptr;
  uint64_t last_present_ms_ = 0;
  bool pending_settle_ = false;
  std::vector<uint8_t> ready_buf_;
  std::vector<uint8_t> front_buf_;
  std::thread worker_;
};

}  // namespace

bool initializeNativeBackend(const std::string& /*output*/, unsigned /*fps*/) { return true; }

std::unique_ptr<CaptureSource> makeCaptureSource() {
  return std::make_unique<AndroidCaptureSource>();
}

}  // namespace relay::android
