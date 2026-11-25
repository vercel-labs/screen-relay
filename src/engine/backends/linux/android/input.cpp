#include "core/input.hpp"
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

namespace relay::android {
namespace {

std::pair<uint16_t, uint16_t> configuredSize() {
  uint16_t w = 360, h = 680;
  if (const char* env = std::getenv("RELAY_ANDROID_SIZE")) {
    int pw = 0, ph = 0;
    if (std::sscanf(env, "%dx%d", &pw, &ph) == 2 && pw >= 320 && ph >= 240) {
      w = static_cast<uint16_t>(pw & ~1);
      h = static_cast<uint16_t>(ph & ~1);
    }
  }
  return {w, h};
}

std::string configuredFifoPath() {
  if (const char* env = std::getenv("RELAY_ANDROID_INPUT_FIFO"); env && *env) return env;
  return "/tmp/ipc/input.fifo";
}

// Maps USB HID keyboard usage codes to Android AKEYCODE_* values.
std::optional<NativeKey> hidToAndroidKey(uint16_t usage) {
  if (usage >= 0x04 && usage <= 0x1D) return static_cast<NativeKey>(29 + (usage - 0x04));  // A-Z
  if (usage >= 0x1E && usage <= 0x26) return static_cast<NativeKey>(8 + (usage - 0x1E));   // 1-9
  if (usage == 0x27) return 7;    // 0
  if (usage == 0x28) return 66;   // Enter
  if (usage == 0x29) return 4;    // Escape -> BACK
  if (usage == 0x2A) return 67;   // Backspace -> DEL
  if (usage == 0x2B) return 61;   // Tab
  if (usage == 0x2C) return 62;   // Space
  if (usage == 0x2D) return 69;   // Minus
  if (usage == 0x2E) return 70;   // Equals
  if (usage == 0x36) return 55;   // Comma
  if (usage == 0x37) return 56;   // Period
  if (usage == 0x38) return 76;   // Slash
  if (usage == 0x4A) return 3;    // Home -> KEYCODE_HOME
  if (usage == 0x4C) return 112;  // Forward Delete
  if (usage == 0x4F) return 22;   // Right
  if (usage == 0x50) return 21;   // Left
  if (usage == 0x51) return 20;   // Down
  if (usage == 0x52) return 19;   // Up
  if (usage == 0xE1 || usage == 0xE5) return 59;  // Shift
  return std::nullopt;
}

class AndroidInputBackend final : public InputBackend {
 public:
  AndroidInputBackend() {
    auto [w, h] = configuredSize();
    width_ = w;
    height_ = h;
    fifo_path_ = configuredFifoPath();
    (void)::mkfifo(fifo_path_.c_str(), 0600);
  }

  ~AndroidInputBackend() override {
    if (fifo_fd_ >= 0) ::close(fifo_fd_);
  }

  std::optional<NativeKey> nativeKey(uint16_t usage) const override {
    return hidToAndroidKey(usage);
  }

  void pressKey(NativeKey key) override {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "K %u 1\n", key);
    sendLine(buf);
  }

  void releaseKey(NativeKey key) override {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "K %u 0\n", key);
    sendLine(buf);
  }

  bool typeText(uint32_t codepoint) override {
    if (codepoint < 0x20 || codepoint > 0x7E) return false;
    char buf[64];
    std::snprintf(buf, sizeof(buf), "T %u\n", codepoint);
    return sendLine(buf);
  }

  void pressButton(unsigned button) override {
    if (button == 1) {
      down_ = true;
      char buf[64];
      std::snprintf(buf, sizeof(buf), "D %d %d\n", x_, y_);
      sendLine(buf);
    } else if (button == 3) {
      pressKey(4);
      releaseKey(4);
    }
  }

  void releaseButton(unsigned button) override {
    if (button == 1 && down_) {
      down_ = false;
      char buf[64];
      std::snprintf(buf, sizeof(buf), "U %d %d\n", x_, y_);
      sendLine(buf);
    }
  }

  void move(int x, int y) override {
    x_ = x;
    y_ = y;
    if (down_) {
      char buf[64];
      std::snprintf(buf, sizeof(buf), "M %d %d\n", x_, y_);
      sendLine(buf);
    }
  }

  void scroll(unsigned axis, int notches) override {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "W %d %d %u %d\n", x_, y_, axis, notches);
    sendLine(buf);
  }

  void resetLocks() override {}
  void fence(std::shared_ptr<InputFence> mark) override {
    if (mark) mark->complete(true, 0);
  }
  size_t pending() const override { return 0; }
  void cancel() override {}
  void flush() override {}
  std::pair<uint16_t, uint16_t> dimensions() const override { return {width_, height_}; }
  const char* name() const override { return "android"; }

 private:
  bool ensureOpen() {
    if (fifo_fd_ >= 0) return true;
    (void)::mkfifo(fifo_path_.c_str(), 0666);
    (void)::chmod(fifo_path_.c_str(), 0666);
    fifo_fd_ = ::open(fifo_path_.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
    return fifo_fd_ >= 0;
  }

  bool sendLine(const char* line) {
    std::lock_guard<std::mutex> lock(mtx_);
    if (!ensureOpen()) return false;
    const size_t len = std::strlen(line);
    if (::write(fifo_fd_, line, len) == static_cast<ssize_t>(len)) return true;
    ::close(fifo_fd_);
    fifo_fd_ = -1;
    if (!ensureOpen()) return false;
    return ::write(fifo_fd_, line, len) == static_cast<ssize_t>(len);
  }

  uint16_t width_ = 360, height_ = 680;
  int x_ = 180, y_ = 340;
  bool down_ = false;
  int fifo_fd_ = -1;
  std::string fifo_path_;
  std::mutex mtx_;
};

}  // namespace

std::unique_ptr<InputBackend> makeInputBackend() {
  return std::make_unique<AndroidInputBackend>();
}

}  // namespace relay::android
