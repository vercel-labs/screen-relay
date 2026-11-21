#include "core/clipboard.hpp"
#include <AppKit/AppKit.h>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>

namespace relay {
namespace {
/// The general pasteboard; a thread polls its change count every 250 ms, because macOS posts no change notice.
class MacClipboard final : public ClipboardBackend {
  ClipboardChanged changed;
  std::mutex mutex;
  std::condition_variable wake;
  bool stopping = false;
  NSInteger lastCount;
  std::thread watcher;

  static NSInteger changeCount() {
    @autoreleasepool { return NSPasteboard.generalPasteboard.changeCount; }
  }
  void watch() {
    std::unique_lock<std::mutex> lock(mutex);
    while (!wake.wait_for(lock, std::chrono::milliseconds(250), [this] { return stopping; })) {
      const NSInteger count = changeCount();
      if (count == lastCount) continue;
      lastCount = count;
      lock.unlock(); changed(); lock.lock();
    }
  }

 public:
  explicit MacClipboard(ClipboardChanged callback) : changed(std::move(callback)), lastCount(changeCount()) {
    watcher = std::thread([this] { watch(); });
  }
  ~MacClipboard() override {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    wake.notify_all();
    watcher.join();
  }
  std::optional<std::string> read() override {
    @autoreleasepool {
      std::lock_guard<std::mutex> lock(mutex);
      NSString* text = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
      const char* bytes = text.UTF8String;
      return std::string(bytes ? bytes : "");
    }
  }
  bool write(const std::string& text) override {
    @autoreleasepool {
      NSString* value = [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
      if (!value) return false;
      std::lock_guard<std::mutex> lock(mutex);
      NSPasteboard* pasteboard = NSPasteboard.generalPasteboard;
      [pasteboard clearContents];
      const bool written = [pasteboard setString:value forType:NSPasteboardTypeString];
      lastCount = pasteboard.changeCount;
      return written;
    }
  }
};
}  // namespace
namespace macos {
std::unique_ptr<ClipboardBackend> makeClipboard(ClipboardChanged changed) {
  return std::make_unique<MacClipboard>(std::move(changed));
}
}  // namespace macos
}  // namespace relay
