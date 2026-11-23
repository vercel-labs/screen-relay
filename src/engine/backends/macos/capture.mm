#include "core/capture-source.hpp"
#include "core/wait.hpp"
#include "backends/macos/display.hpp"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace relay {
namespace macos {
struct CaptureState;
}
}

@interface RelayCaptureOutput : NSObject <SCStreamOutput, SCStreamDelegate> {
 @public
  std::weak_ptr<relay::macos::CaptureState> state;
}
@end

namespace relay {
namespace macos {
namespace {
constexpr size_t max_pending_rects = 256;

std::string errorMessage(NSError* error, const char* action) {
  if (error.code == SCStreamErrorUserDeclined)
    return "Screen Recording permission is missing. In System Settings > Privacy & Security > Screen & System Audio Recording, enable the app that started relay, then restart it";
  const char* description = error.localizedDescription.UTF8String;
  return std::string(action) + ": " + (description ? description : "unknown error") + " (" + std::to_string(error.code) + ")";
}

struct ContentResult {
  std::mutex mutex;
  std::condition_variable ready;
  bool done = false;
  SCShareableContent* content = nil;
  NSError* error = nil;
};

struct StartResult {
  std::mutex mutex;
  std::condition_variable ready;
  bool done = false, abandoned = false;
  NSError* error = nil;
};

class PixelLock {
 public:
  explicit PixelLock(CVPixelBufferRef value) : buffer(value) {
    if (CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess)
      throw std::runtime_error("Locking the screen capture image failed");
  }
  ~PixelLock() { unlock(); }
  void unlock() {
    if (buffer) { CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly); buffer = nullptr; }
  }
 private:
  CVPixelBufferRef buffer;
};

/// Waits up to ten seconds for a ScreenCaptureKit call that reports only an error.
void awaitUpdate(void (^begin)(void (^)(NSError*)), const char* action) {
  auto result = std::make_shared<StartResult>();
  begin(^(NSError* error) {
    std::lock_guard<std::mutex> guard(result->mutex);
    result->error = error;
    result->done = true;
    result->ready.notify_one();
  });
  std::unique_lock<std::mutex> lock(result->mutex);
  if (!result->ready.wait_for(lock, std::chrono::seconds(10), [&] { return result->done; }))
    throw std::runtime_error(std::string(action) + " timed out");
  if (result->error) throw std::runtime_error(errorMessage(result->error, action));
}

SCDisplay* findShareableDisplay(CGDirectDisplayID id) {
  auto contentResult = std::make_shared<ContentResult>();
  [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
    completionHandler:^(SCShareableContent* content, NSError* error) {
      std::lock_guard<std::mutex> lock(contentResult->mutex);
      contentResult->content = content;
      contentResult->error = error;
      contentResult->done = true;
      contentResult->ready.notify_one();
    }];
  std::unique_lock<std::mutex> lock(contentResult->mutex);
  if (!contentResult->ready.wait_for(lock, std::chrono::seconds(10), [&] { return contentResult->done; }))
    throw std::runtime_error("Timed out listing displays for screen capture");
  if (contentResult->error) throw std::runtime_error(errorMessage(contentResult->error, "Listing displays for screen capture"));
  for (SCDisplay* candidate in contentResult->content.displays)
    if (candidate.displayID == id) return candidate;
  throw std::runtime_error("The selected display is not available for screen capture");
}

SCStreamConfiguration* makeConfiguration(const Display& display) {
  SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
  config.width = display.width;
  config.height = display.height;
  config.pixelFormat = kCVPixelFormatType_32BGRA;
  config.colorSpaceName = kCGColorSpaceSRGB;
  config.showsCursor = NO;
  config.queueDepth = 3;
  config.minimumFrameInterval = kCMTimeZero;
  return config;
}

class MacCapture;
}

/// Holds the latest screen image, capture failure, and subscribed sources, and follows the display through size changes.
struct CaptureState {
  explicit CaptureState(Display selected) : display(selected) {
    requireSurfaceSize(display.width, display.height);
    image.resize(size_t(display.width) * display.height * 4);
  }
  Display display;
  std::mutex mutex;
  std::condition_variable arrived;
  std::vector<uint8_t> image;
  std::vector<MacCapture*> sources;
  bool haveFrame = false;
  std::string failure;
  SCStream* stream = nil;
  std::atomic<uint64_t> epoch{0};
  int staleWidth = 0, staleHeight = 0;

  Display snapshot();
  void fail(const std::string& message);
  bool checkDisplay();
  void reconfigure(const Display& now);
  void stopped(NSError* error);
  void frame(CMSampleBufferRef sample);
};

namespace {
/// Shares one screen capture stream across capture sources.
class SharedCapture {
 public:
  static std::shared_ptr<SharedCapture> shared() {
    static std::mutex mutex;
    static std::weak_ptr<SharedCapture> current;
    std::lock_guard<std::mutex> lock(mutex);
    auto existing = current.lock();
    if (!existing || existing->failed()) {
      if (existing) existing->stop();
      existing = std::make_shared<SharedCapture>();
      existing->start();
      current = existing;
    }
    return existing;
  }

  SharedCapture() : state(std::make_shared<CaptureState>(findDisplay())) {}
  ~SharedCapture() { stop(); }
  void stop() {
    @autoreleasepool {
      if (timer) { dispatch_source_cancel(timer); timer = nil; }
      if (started) { started = false; [state->stream stopCaptureWithCompletionHandler:nil]; }
    }
  }
  bool failed() const {
    std::lock_guard<std::mutex> lock(state->mutex);
    return !state->failure.empty();
  }
  void start() {
    @autoreleasepool {
      SCDisplay* selected = findShareableDisplay(state->display.id);
      SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:@[]];
      SCStreamConfiguration* config = makeConfiguration(state->display);
      output = [[RelayCaptureOutput alloc] init];
      output->state = state;
      queue = dispatch_queue_create("relay.macos.capture", DISPATCH_QUEUE_SERIAL);
      SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];
      state->stream = stream;
      NSError* error = nil;
      if (![stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&error])
        throw std::runtime_error(errorMessage(error, "Adding screen capture output"));
      auto result = std::make_shared<StartResult>();
      SCStream* starting = stream;
      [stream startCaptureWithCompletionHandler:^(NSError* startError) {
        std::lock_guard<std::mutex> guard(result->mutex);
        if (result->abandoned) {
          if (!startError) [starting stopCaptureWithCompletionHandler:nil];
          return;
        }
        result->error = startError;
        result->done = true;
        result->ready.notify_one();
      }];
      std::unique_lock<std::mutex> startLock(result->mutex);
      if (!result->ready.wait_for(startLock, std::chrono::seconds(10), [&] { return result->done; })) {
        result->abandoned = true;
        throw std::runtime_error("Timed out starting screen capture");
      }
      if (result->error) throw std::runtime_error(errorMessage(result->error, "Starting screen capture"));
      started = true;
      timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
      std::weak_ptr<CaptureState> weak = state;
      dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_SEC / 10);
      dispatch_source_set_event_handler(timer, ^{ if (auto current = weak.lock()) current->checkDisplay(); });
      dispatch_resume(timer);
    }
  }
  std::shared_ptr<CaptureState> state;
 private:
  RelayCaptureOutput* output = nil;
  dispatch_queue_t queue = nil;
  dispatch_source_t timer = nil;
  bool started = false;
};

/// Provides frames and damage notifications to one capture consumer.
class MacCapture final : public CaptureSource {
 public:
  MacCapture() : shared(SharedCapture::shared()), state(shared->state) {
    const Display display = state->snapshot();
    width = display.width;
    height = display.height;
    front.resize(size_t(width) * height * 4);
    if (!ready.valid()) throw std::runtime_error("Creating the capture pipe failed");
    ready.signal();
    std::unique_lock<std::mutex> lock(state->mutex);
    epoch = state->epoch;
    state->sources.push_back(this);
    if (!state->arrived.wait_for(lock, std::chrono::seconds(2), [&] { return state->haveFrame || !state->failure.empty(); })) {
      state->sources.erase(std::remove(state->sources.begin(), state->sources.end(), this), state->sources.end());
      throw std::runtime_error("Timed out waiting for the first screen capture frame");
    }
    if (!state->failure.empty()) {
      const std::string error = state->failure;
      state->sources.erase(std::remove(state->sources.begin(), state->sources.end(), this), state->sources.end());
      throw std::runtime_error(error);
    }
  }
  ~MacCapture() override {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->sources.erase(std::remove(state->sources.begin(), state->sources.end(), this), state->sources.end());
  }
  WaitHandle fd() const override { return ready.handle(); }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  bool resized() const override { return state->epoch != epoch; }
  PixelFormat pixelFormat() const override { return PixelFormat::BGRA; }
  bool drainDamage() override {
    std::lock_guard<std::mutex> lock(mutex);
    ready.consume();
    return pendingFull || !pending.empty();
  }
  FrameView capture() override { return captureChanged(true); }
  FrameView captureChanged(bool full) override {
    std::vector<DamageRect> rects;
    {
      std::lock_guard<std::mutex> lock(mutex);
      lastFull = full || pendingFull;
      rects.swap(pending);
      pendingFull = false;
      last = lastFull ? std::vector<DamageRect>{} : rects;
    }
    std::lock_guard<std::mutex> lock(state->mutex);
    if (!state->failure.empty()) throw std::runtime_error(state->failure);
    if (state->epoch != epoch) throw std::runtime_error("The display size changed");
    if (lastFull) std::memcpy(front.data(), state->image.data(), front.size());
    else for (const auto& rect : rects)
      for (int y = rect.y; y < rect.y + rect.height; ++y)
        std::memcpy(front.data() + (size_t(y) * width + rect.x) * 4,
                    state->image.data() + (size_t(y) * width + rect.x) * 4, size_t(rect.width) * 4);
    return {front.data(), width * 4, width, height, PixelFormat::BGRA};
  }
  bool changedRects(std::vector<DamageRect>& rects) override {
    std::lock_guard<std::mutex> lock(mutex);
    if (lastFull) return false;
    rects = last;
    return true;
  }
  void damaged(const std::vector<DamageRect>& rects, bool full) {
    std::lock_guard<std::mutex> lock(mutex);
    if (full || (!pendingFull && rects.size() > max_pending_rects - pending.size())) {
      pendingFull = true; pending.clear();
    } else if (!pendingFull) pending.insert(pending.end(), rects.begin(), rects.end());
    ready.signal();
  }
 private:
  std::shared_ptr<SharedCapture> shared;
  std::shared_ptr<CaptureState> state;
  int width = 0, height = 0;
  uint64_t epoch = 0;
  Wake ready;
  std::mutex mutex;
  std::vector<uint8_t> front;
  std::vector<DamageRect> pending, last;
  bool pendingFull = true, lastFull = true;
};

/// Converts ScreenCaptureKit dirty rectangles to clipped pixel damage, or returns false when unavailable.
bool dirtyRects(id value, int width, int height, std::vector<DamageRect>& rects) {
  if (![value isKindOfClass:[NSArray class]] || [value count] == 0) return false;
  for (id item in (NSArray*)value) {
    CGRect rect;
    if ([item isKindOfClass:[NSDictionary class]]) {
      if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)item, &rect)) return false;
    } else if ([item isKindOfClass:[NSValue class]] && std::strcmp([(NSValue*)item objCType], @encode(CGRect)) == 0) {
      [(NSValue*)item getValue:&rect size:sizeof(rect)];
    } else return false;
    const double x0 = CGRectGetMinX(rect), y0 = CGRectGetMinY(rect);
    const double x1 = CGRectGetMaxX(rect), y1 = CGRectGetMaxY(rect);
    if (!std::isfinite(x0) || !std::isfinite(y0) || !std::isfinite(x1) || !std::isfinite(y1)) return false;
    const int left = int(std::floor(std::clamp(x0, 0.0, double(width))));
    const int top = int(std::floor(std::clamp(y0, 0.0, double(height))));
    const int right = int(std::ceil(std::clamp(x1, 0.0, double(width))));
    const int bottom = int(std::ceil(std::clamp(y1, 0.0, double(height))));
    if (right > left && bottom > top) rects.push_back({left, top, right - left, bottom - top});
  }
  return !rects.empty();
}
}

void CaptureState::fail(const std::string& message) {
  std::lock_guard<std::mutex> lock(mutex);
  if (!failure.empty()) return;
  failure = message;
  arrived.notify_all();
  for (auto* source : sources) source->damaged({}, true);
}

Display CaptureState::snapshot() {
  std::lock_guard<std::mutex> lock(mutex);
  return display;
}

/// Reports whether the display changed and the stream now follows it; any other change fails the capture.
bool CaptureState::checkDisplay() {
  try {
    const auto now = findDisplay();
    const bool resized = now.id != display.id || now.width != display.width || now.height != display.height;
    if (resized) {
      reconfigure(now);
      return true;
    }
    std::lock_guard<std::mutex> lock(mutex);
    display = now;
  } catch (const std::exception& error) { fail(error.what()); }
  return false;
}

void CaptureState::reconfigure(const Display& now) {
  requireSurfaceSize(now.width, now.height);
  if (now.id != display.id) {
    SCDisplay* selected = findShareableDisplay(now.id);
    SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:@[]];
    awaitUpdate(^(void (^done)(NSError*)) { [stream updateContentFilter:filter completionHandler:done]; },
                "Moving screen capture to another display");
  }
  SCStreamConfiguration* config = makeConfiguration(now);
  awaitUpdate(^(void (^done)(NSError*)) { [stream updateConfiguration:config completionHandler:done]; },
              "Resizing screen capture");
  std::lock_guard<std::mutex> lock(mutex);
  staleWidth = display.width;
  staleHeight = display.height;
  display = now;
  image.assign(size_t(now.width) * now.height * 4, 0);
  haveFrame = false;
  ++epoch;
  for (auto* source : sources) source->damaged({}, true);
}

void CaptureState::stopped(NSError* error) {
  try {
    findDisplay();
    fail(errorMessage(error, "Screen capture stopped"));
  } catch (const std::exception& failure) { fail(failure.what()); }
}

void CaptureState::frame(CMSampleBufferRef sample) {
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  if (!attachments || CFArrayGetCount(attachments) == 0) return;
  NSDictionary* info = (__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments, 0);
  NSNumber* status = info[SCStreamFrameInfoStatus];
  if (!status || (status.integerValue != SCFrameStatusComplete && status.integerValue != SCFrameStatusStarted)) return;
  CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
  if (!buffer || CVPixelBufferGetWidth(buffer) != size_t(display.width) ||
      CVPixelBufferGetHeight(buffer) != size_t(display.height) || CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA) {
    if (buffer && CVPixelBufferGetWidth(buffer) == size_t(staleWidth) && CVPixelBufferGetHeight(buffer) == size_t(staleHeight)) return;
    if (checkDisplay()) return;
    throw std::runtime_error("Screen capture returned an invalid image");
  }
  std::vector<DamageRect> rects;
  bool full = !dirtyRects(info[SCStreamFrameInfoDirtyRects], display.width, display.height, rects);
  for (const auto& rect : rects)
    if (rect.x == 0 && rect.y == 0 && rect.width == display.width && rect.height == display.height) full = true;
  PixelLock pixelsLock(buffer);
  const auto* pixels = static_cast<const uint8_t*>(CVPixelBufferGetBaseAddress(buffer));
  const size_t stride = CVPixelBufferGetBytesPerRow(buffer);
  if (!pixels || stride < size_t(display.width) * 4)
    throw std::runtime_error("Screen capture returned an invalid image stride");
  std::lock_guard<std::mutex> lock(mutex);
  if (!failure.empty()) return;
  full = full || !haveFrame;
  if (full) rects = {{0, 0, display.width, display.height}};
  for (const auto& rect : rects)
    for (int y = rect.y; y < rect.y + rect.height; ++y)
      std::memcpy(image.data() + (size_t(y) * display.width + rect.x) * 4,
                  pixels + size_t(y) * stride + size_t(rect.x) * 4, size_t(rect.width) * 4);
  pixelsLock.unlock();
  haveFrame = true;
  arrived.notify_all();
  for (auto* source : sources) source->damaged(rects, full);
}

std::unique_ptr<CaptureSource> makeCaptureSource() { return std::make_unique<MacCapture>(); }
}
}

@implementation RelayCaptureOutput
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeScreen) return;
  @autoreleasepool {
    if (auto current = state.lock()) {
      try { current->frame(sample); }
      catch (const std::exception& error) { current->fail(error.what()); }
    }
  }
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
  (void)stream;
  @autoreleasepool {
    if (auto current = state.lock()) current->stopped(error);
  }
}
@end
