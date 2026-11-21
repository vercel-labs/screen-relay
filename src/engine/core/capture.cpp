#include "capture.hpp"
#include "capture-bucket.hpp"
#include "color.hpp"
#include "cpu-budget.hpp"
#include "encoder.hpp"
#include "flow.hpp"
#include "wait.hpp"

#include <x264.h>
#include <algorithm>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace relay {
namespace {
constexpr int parallel_convert_macroblocks = 512;
using Clock = std::chrono::steady_clock;

uint64_t ns(Clock::duration d) {
  return uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(d).count());
}

void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}

/** Runs one job across worker threads plus the caller and returns once all finish. */
class Workers {
 public:
  explicit Workers(int count) {
    for (int i = 1; i < count; ++i) threads.emplace_back([this] { loop(); });
  }
  ~Workers() {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    wake.notify_all();
    for (auto& thread : threads) thread.join();
  }
  int size() const { return int(threads.size()) + 1; }
  void run(const std::function<void(int)>& job) {
    { std::lock_guard<std::mutex> lock(mutex); task = &job; next = 1; pending = int(threads.size()); ++round; }
    wake.notify_all();
    job(0);
    std::unique_lock<std::mutex> lock(mutex);
    finished.wait(lock, [this] { return pending == 0; });
    task = nullptr;
  }
 private:
  void loop() {
    uint64_t seen = 0;
    std::unique_lock<std::mutex> lock(mutex);
    while (true) {
      wake.wait(lock, [&] { return stopping || round != seen; });
      if (stopping) return;
      seen = round;
      const int part = next++;
      const auto* job = task;
      lock.unlock();
      (*job)(part);
      lock.lock();
      if (--pending == 0) finished.notify_one();
    }
  }
  std::vector<std::thread> threads;
  std::mutex mutex;
  std::condition_variable wake, finished;
  const std::function<void(int)>* task = nullptr;
  uint64_t round = 0;
  int next = 0, pending = 0;
  bool stopping = false;
};

/** Metadata tracked per submitted frame so async encoders assign monotonic sequences in order. */
struct SubmittedJob {
  uint64_t tag = 0;
  uint32_t generation = 0;
  uint64_t revision = 0;
  int64_t pts_us = 0;
  bool captured_frame = true;
  bool force_idr = false;
  bool refinement = false;
  uint64_t capture_ns = 0;
  uint64_t convert_ns = 0;
};

/** Owns the pixel conversion workers, macroblock change tracking, and EncoderController. */
struct Pipeline {
  PixelFormat format;
  int width, height;
  CaptureSettings settings;
  EncoderController controller;
  std::vector<uint8_t> mb_info;
  int threads;
  std::vector<std::vector<uint8_t>> scratch;
  Workers workers;

  Pipeline(PixelFormat f, int w, int h, CaptureSettings s, EncoderFactories factories)
      : format(f), width(w), height(h), settings(std::move(s)), controller(std::move(factories)),
        mb_info(size_t((w + 15) / 16) * size_t((h + 15) / 16)),
        threads(encoderThreads(h)),
        scratch(size_t(threads), std::vector<uint8_t>(size_t(w) * 24)), workers(threads) {}

  void open(EncoderReadyCallback on_ready) {
    EncoderConfig cfg;
    cfg.preference = settings.encoder;
    cfg.width = width;
    cfg.height = height;
    cfg.fps = settings.fps;
    cfg.bitrate_bps = settings.start_bitrate;
    cfg.source_bgra = (format == PixelFormat::BGRA);
    controller.open(cfg, std::move(on_ready));
  }

  /** Writes a full frame into the encoder's fresh plane pointers as BGRA or converted NV12. */
  bool convertFull(const FrameView& view, const EncoderPlanes& planes, bool rgb) {
    if (!rgb) {
      const auto convert = view.format == PixelFormat::BGRA ? bgraToNv12 : argbToNv12;
      return convert(view.data, view.stride, planes.data[0], planes.stride[0],
                     planes.data[1], planes.stride[1], view.width, view.height);
    }
    for (int y = 0; y < view.height; ++y)
      std::memcpy(planes.data[0] + size_t(y) * size_t(planes.stride[0]),
                  view.data + size_t(y) * size_t(view.stride), size_t(view.width) * 4);
    return true;
  }

  /** Copies one damaged BGRA macroblock into plane 0 and returns whether any pixel changed. */
  bool copyBlock(const FrameView& view, const EncoderPlanes& planes, int left, int right, int y0, int y1) {
    bool different = false;
    for (int y = y0; y < y1; ++y) {
      uint8_t* target = planes.data[0] + size_t(y) * size_t(planes.stride[0]) + size_t(left) * 4;
      const uint8_t* source = view.data + size_t(y - view.y) * size_t(view.stride) + size_t(left - view.x) * 4;
      if (std::memcmp(target, source, size_t(right - left) * 4) != 0) {
        std::memcpy(target, source, size_t(right - left) * 4);
        different = true;
      }
    }
    return different;
  }

  bool convertDamage(const FrameView& view, const std::vector<DamageRect>& rects, const EncoderPlanes& planes, bool rgb) {
    const int columns = (width + 15) / 16;
    const int rows = (height + 15) / 16;
    std::fill(mb_info.begin(), mb_info.end(), uint8_t(X264_MBINFO_CONSTANT));
    for (const auto& rect : rects) {
      const int x0 = std::max(rect.x, view.x), y0 = std::max(rect.y, view.y);
      const int x1 = std::min(rect.x + rect.width, view.x + view.width);
      const int y1 = std::min(rect.y + rect.height, view.y + view.height);
      if (x0 >= x1 || y0 >= y1) continue;
      for (int row = y0 / 16; row <= (y1 - 1) / 16; ++row)
        std::fill(mb_info.begin() + row * columns + x0 / 16, mb_info.begin() + row * columns + (x1 - 1) / 16 + 1, 0);
    }
    int first = rows, last = 0, damaged = 0;
    for (int row = 0; row < rows; ++row) {
      const int count = int(std::count(mb_info.begin() + row * columns, mb_info.begin() + (row + 1) * columns, 0));
      if (!count) continue;
      first = std::min(first, row);
      last = row + 1;
      damaged += count;
    }
    if (!damaged) return false;
    if (workers.size() == 1 || damaged < parallel_convert_macroblocks || last - first < 2) {
      bool changed = false;
      require(convertRows(view, first, last, scratch[0], planes, rgb, changed), "RGB conversion failed");
      return changed;
    }
    const int parts = std::min(workers.size(), last - first);
    std::vector<uint8_t> part_changed(static_cast<size_t>(parts), 0);
    std::vector<uint8_t> part_failed(static_cast<size_t>(parts), 0);
    workers.run([&](int part) {
      if (part >= parts) return;
      const int begin = first + (last - first) * part / parts;
      const int end = first + (last - first) * (part + 1) / parts;
      bool local_changed = false;
      part_failed[size_t(part)] = !convertRows(view, begin, end, scratch[size_t(part)], planes, rgb, local_changed);
      part_changed[size_t(part)] = local_changed;
    });
    bool changed = false, failed = false;
    for (int part = 0; part < parts; ++part) {
      changed |= part_changed[size_t(part)] != 0;
      failed |= part_failed[size_t(part)] != 0;
    }
    require(!failed, "RGB conversion failed");
    return changed;
  }

  bool convertRows(const FrameView& view, int begin, int end, std::vector<uint8_t>& buffer,
                   const EncoderPlanes& planes, bool rgb, bool& changed) {
    const int columns = (width + 15) / 16;
    const auto convert = view.format == PixelFormat::BGRA ? bgraToNv12 : argbToNv12;
    for (int row = begin; row < end; ++row) {
      const int y0 = std::max(row * 16, view.y);
      const int y1 = std::min(row * 16 + 16, view.y + view.height);
      for (int column = view.x / 16; column <= (view.x + view.width - 1) / 16;) {
        if (mb_info[row * columns + column]) { ++column; continue; }
        const int first = column;
        while (column <= (view.x + view.width - 1) / 16 && !mb_info[row * columns + column]) ++column;
        const int x0 = std::max(first * 16, view.x);
        const int x1 = std::min(column * 16, view.x + view.width);
        if (rgb) {
          for (int block = first; block < column; ++block) {
            const bool different = copyBlock(view, planes, std::max(block * 16, x0), std::min(block * 16 + 16, x1), y0, y1);
            mb_info[row * columns + block] = different ? 0 : uint8_t(X264_MBINFO_CONSTANT);
            changed |= different;
          }
          continue;
        }
        if (!convert(view.data + size_t(y0 - view.y) * size_t(view.stride) + size_t(x0 - view.x) * 4, view.stride,
                     buffer.data(), width, buffer.data() + size_t(width) * 16, width, x1 - x0, y1 - y0)) return false;
        for (int block = first; block < column; ++block) {
          const int left = std::max(block * 16, x0), right = std::min(block * 16 + 16, x1);
          bool different = false;
          for (int plane = 0; plane < 2; ++plane) {
            const int lines = plane ? (y1 - y0) / 2 : y1 - y0;
            uint8_t* target = planes.data[plane] + size_t(plane ? y0 / 2 : y0) * size_t(planes.stride[plane]) + left;
            const uint8_t* source = buffer.data() + size_t(plane ? width * 16 : 0) + (left - x0);
            for (int line = 0; line < lines; ++line) {
              if (std::memcmp(target, source, size_t(right - left)) != 0) {
                std::memcpy(target, source, size_t(right - left));
                different = true;
              }
              target += planes.stride[plane];
              source += width;
            }
          }
          mb_info[row * columns + block] = different ? 0 : uint8_t(X264_MBINFO_CONSTANT);
          changed |= different;
        }
      }
    }
    return true;
  }
};
}  // namespace

struct CaptureEncoder::Impl {
  Publish publish;
  PublishCursor publish_cursor;
  CaptureSettings settings;
  CaptureSourceFactory source_factory;
  EncoderFactories encoder_factories;
  mutable std::mutex mutex;
  std::condition_variable ready;
  std::thread worker;
  Wake wake_event;
  bool stopping = false, initialized = false, running = false, keyframe_requested = false;
  std::string startup_error;
  std::string fatal_error;
  uint32_t generation = 0, sequence = 0, acknowledged = 0;
  uint64_t revision = 0;
  unsigned window = 1;
  uint64_t bitrate;
  uint64_t admit_until_us = 0;
  bool active = false, paused = false;
  CaptureStats counters;

  Impl(Publish cb, CaptureSettings s, CaptureSourceFactory factory, PublishCursor cursor_cb, EncoderFactories ef)
      : publish(std::move(cb)), publish_cursor(std::move(cursor_cb)), settings(std::move(s)),
        source_factory(std::move(factory)), encoder_factories(std::move(ef)), bitrate(settings.start_bitrate) {}

  void wake() { wake_event.signal(); }

  void syncEncoderStats(const EncoderController& controller) {
    std::lock_guard<std::mutex> lock(mutex);
    counters.encoder = controller.name();
    counters.hardware_encoder = controller.hardware();
    counters.transfer_tier = controller.transferTier();
    counters.encoder_state = encoderStateName(controller.state());
    counters.profile_level_id = controller.profileLevelId();
    counters.dropped_frames = controller.droppedFrames();
    counters.fallback_count = controller.fallbackCount();
  }

  void run() {
    try {
      require(wake_event.valid(), "creating capture wake handle failed");
      std::unique_ptr<CaptureSource> source = source_factory();
      require(bool(source), "creating capture source failed");
      const auto dimensions = source->dimensions();
      const int width = dimensions.first, height = dimensions.second;
      requireSurfaceSize(width, height);
      const PixelFormat format = source->pixelFormat();
      require(format == PixelFormat::BGRA || format == PixelFormat::ARGB, "unsupported capture pixel format");
      const WaitHandle damage_fd = source->fd();
      require(validWaitHandle(damage_fd), "invalid capture source wait handle");

      Pipeline p(format, width, height, settings, encoder_factories);
      p.open([this] { wake(); });

      {
        std::lock_guard<std::mutex> lock(mutex);
        counters.cursor_supported = source->cursorSupported();
        counters.encoder = p.controller.name();
        counters.hardware_encoder = p.controller.hardware();
        counters.transfer_tier = p.controller.transferTier();
        counters.encoder_state = encoderStateName(p.controller.state());
        counters.profile_level_id = p.controller.profileLevelId();
        initialized = true;
        running = true;
      }
      ready.notify_all();

      bool dirty = true, force_idr = true;
      uint64_t seen_revision = 0;
      uint64_t next_tag = 0;
      int64_t last_pts = -1;
      unsigned consecutive_capture_failures = 0;
      Clock::time_point retry_after{};
      std::vector<DamageRect> rects;
      std::deque<SubmittedJob> pending_jobs;
      std::vector<EncodeResult> completed;

      const auto frame_interval = std::chrono::nanoseconds(1000000000LL / std::max(1u, settings.fps));
      CaptureBucket bucket;
      bucket.reset(int64_t(ns(Clock::now().time_since_epoch())), frame_interval.count());
      const auto refinement_delay = std::chrono::milliseconds(150);
      constexpr unsigned max_refinements = 2;
      bool refining = false, last_was_refinement = false;
      unsigned refinements = 0;
      Clock::time_point last_publish{};

      auto reset_refinement = [&] {
        refining = false;
        last_was_refinement = false;
        refinements = 0;
      };

      auto drain_results = [&](bool flush_all) {
        completed.clear();
        if (flush_all) p.controller.active().flush(completed);
        else p.controller.active().poll(completed, false);

        for (auto& res : completed) {
          const auto it = std::find_if(pending_jobs.begin(), pending_jobs.end(),
              [&](const SubmittedJob& entry) { return entry.tag == res.tag; });
          if (it == pending_jobs.end()) continue;
          const SubmittedJob job = *it;
          pending_jobs.erase(pending_jobs.begin(), std::next(it));

          bool stale = false;
          {
            std::lock_guard<std::mutex> lock(mutex);
            stale = (job.revision != revision || job.generation != generation || !active);
          }
          if (stale) continue;

          const EncoderDecision decision = p.controller.evaluate(res, job.force_idr);
          syncEncoderStats(p.controller);

          if (decision.action == EncoderAction::fatal) {
            throw std::runtime_error("encoder failed: " + decision.message);
          }
          if (decision.action == EncoderAction::recover_idr) {
            std::vector<EncodeResult> discarded;
            p.controller.active().flush(discarded);
            pending_jobs.clear();
            dirty = true;
            force_idr = true;
            reset_refinement();
            if (!decision.switched_to_software) {
              retry_after = Clock::now() + std::chrono::milliseconds(200);
            }
            return;
          }
          if (decision.action == EncoderAction::drop) {
            {
              std::lock_guard<std::mutex> lock(mutex);
              if (job.captured_frame) ++counters.captures;
              counters.capture_ns += job.capture_ns;
              counters.convert_ns += job.convert_ns;
              counters.encode_ns += res.encode_ns;
            }
            continue;
          }

          uint32_t seq = 0;
          bool current = false;
          {
            std::lock_guard<std::mutex> lock(mutex);
            if (job.captured_frame) ++counters.captures;
            ++counters.encoded;
            counters.capture_ns += job.capture_ns;
            counters.convert_ns += job.convert_ns;
            counters.encode_ns += res.encode_ns;
            current = (job.revision == revision && job.generation == generation && active);
            if (current) seq = ++sequence;
          }
          if (!current) continue;

          auto output = std::make_shared<EncodedFrame>();
          output->generation = job.generation;
          output->sequence = seq;
          output->pts_us = res.pts_us;
          output->width = uint16_t(width);
          output->height = uint16_t(height);
          output->keyframe = res.keyframe;
          output->annex_b = std::move(res.annex_b);

          if (!publish(std::move(output))) {
            std::fprintf(stderr, "capture: publish rejected; awaiting new session\n");
            {
              std::lock_guard<std::mutex> lock(mutex);
              if (generation == job.generation) active = false;
            }
            std::vector<EncodeResult> discarded;
            p.controller.active().flush(discarded);
            pending_jobs.clear();
            dirty = true;
            force_idr = true;
            reset_refinement();
            return;
          }

          consecutive_capture_failures = 0;
          last_publish = Clock::now();
          last_was_refinement = job.refinement;
          if (!job.refinement) {
            refining = true;
            refinements = 0;
          } else if (res.converged || ++refinements >= max_refinements) {
            refining = false;
          }

          if (decision.switched_to_software) {
            std::vector<EncodeResult> discarded;
            p.controller.active().flush(discarded);
            pending_jobs.clear();
            dirty = true;
            force_idr = true;
            reset_refinement();
            return;
          }
        }
      };

      while (true) {
        if (source->drainDamage()) dirty = true;
        drain_results(false);

        uint32_t gen = 0;
        uint64_t rev = 0, rate = 0;
        bool admitted = false, cursor_active = false, queue_empty = false, refresh_cursor = false;
        unsigned inflight_pipeline = unsigned(pending_jobs.size());
        const unsigned max_pipeline = p.controller.active().maxInflight();

        bool flush_for_revision = false;
        {
          std::lock_guard<std::mutex> lock(mutex);
          if (stopping) break;
          if (revision != seen_revision) {
            seen_revision = revision;
            keyframe_requested = false;
            dirty = true;
            force_idr = true;
            reset_refinement();
            refresh_cursor = true;
            flush_for_revision = true;
          } else if (keyframe_requested) {
            keyframe_requested = false;
            dirty = true;
            force_idr = true;
            reset_refinement();
            refresh_cursor = true;
          }
        }
        if (flush_for_revision) {
          std::vector<EncodeResult> discarded;
          p.controller.active().flush(discarded);
          pending_jobs.clear();
          inflight_pipeline = 0;
        }
        {
          std::lock_guard<std::mutex> lock(mutex);
          if (stopping) break;
          gen = generation;
          rev = revision;
          rate = bitrate;
          cursor_active = gen != 0 && active && bool(publish_cursor);
          queue_empty = (sequence == acknowledged) && (inflight_pipeline == 0);
          const bool idr_blocked = force_idr && inflight_pipeline > 0;
          admitted = gen != 0 && active && !paused && !idr_blocked &&
                     (!admit_until_us || uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(
                         Clock::now().time_since_epoch()).count()) < admit_until_us) &&
                     (sequence - acknowledged) + inflight_pipeline < window &&
                     inflight_pipeline < max_pipeline &&
                     sequence < std::numeric_limits<uint32_t>::max();
        }

        bool cursor_published = false;
        if (cursor_active) {
          if (auto cursor = source->cursor(refresh_cursor)) {
            publish_cursor(gen, std::move(*cursor));
            cursor_published = true;
          }
        }

        const auto now = Clock::now();
        const int64_t now_ns = int64_t(ns(now.time_since_epoch()));
        const bool refinement_pending = !dirty && refining;
        const auto refinement_pace = last_was_refinement ? frame_interval : refinement_delay;
        const bool refinement_ready = !refinement_pending || now >= last_publish + refinement_pace;

        if (admitted && (dirty || (refinement_pending && queue_empty)) && now >= retry_after &&
            refinement_ready && bucket.ready(now_ns)) {
          bool refinement = !dirty;
          const bool captured_frame = !refinement;
          const auto capture_start = Clock::now();
          const bool submit_idr = force_idr;
          void* native_handle = nullptr;

          struct NativeHandleGuard {
            CaptureSource* src = nullptr;
            void* handle = nullptr;
            ~NativeHandleGuard() { if (src && handle) src->releaseNative(handle); }
          } native_guard{source.get(), nullptr};

          try {
            assert(!refinement || (!submit_idr && last_pts >= 0));
            dirty = false;
            auto captured = capture_start, converted = capture_start;
            const EncoderInput input_fmt = p.controller.inputFormat();

            if (!refinement) {
              const FrameView view = (input_fmt == EncoderInput::native_handle)
                  ? source->captureNative(submit_idr)
                  : source->captureChanged(submit_idr);
              captured = Clock::now();
              if (input_fmt == EncoderInput::native_handle && view.native_handle != nullptr) {
                native_guard.handle = view.native_handle;
              }

              const bool zero_copy = (input_fmt == EncoderInput::native_handle && view.native_handle != nullptr);
              if (zero_copy) {
                require(view.width == width && view.height == height && view.format == p.format,
                        "invalid native capture frame");
                native_handle = view.native_handle;
                rects = {{view.x, view.y, view.width, view.height}};
              } else {
                require(view.data && view.width > 0 && view.height > 0 &&
                        view.x >= 0 && view.x <= width && view.y >= 0 && view.y <= height &&
                        view.width <= width - view.x && view.height <= height - view.y &&
                        view.stride >= view.width * 4 && view.stride <= width * 8 &&
                        !(view.x & 1) && !(view.y & 1) && !(view.width & 1) && !(view.height & 1) &&
                        !(submit_idr && (view.width != width || view.height != height)) &&
                        view.format == p.format, "invalid capture frame");
                const bool rgb_planes = (input_fmt != EncoderInput::nv12);
                const EncoderPlanes planes = p.controller.active().planes();
                require(planes.data[0] != nullptr, "encoder planes unavailable");
                bool changed = true;
                if (submit_idr) {
                  rects = {{view.x, view.y, view.width, view.height}};
                  require(p.convertFull(view, planes, rgb_planes), "RGB conversion failed");
                } else {
                  if (!source->changedRects(rects)) rects = {{view.x, view.y, view.width, view.height}};
                  changed = p.convertDamage(view, rects, planes, rgb_planes);
                }
                converted = Clock::now();
                if (!changed) {
                  if (refining && queue_empty && converted >= last_publish + refinement_pace) {
                    refinement = true;
                  } else {
                    {
                      std::lock_guard<std::mutex> lock(mutex);
                      ++counters.captures;
                      counters.capture_ns += ns(captured - capture_start);
                      counters.convert_ns += ns(converted - captured);
                    }
                    consecutive_capture_failures = 0;
                    bucket.spend(int64_t(ns(converted.time_since_epoch())));
                    continue;
                  }
                }
              }
              converted = Clock::now();
            }

            const int64_t timestamp = std::chrono::duration_cast<std::chrono::microseconds>(capture_start.time_since_epoch()).count();
            last_pts = std::max(last_pts + 1, timestamp);
            const uint64_t tag = ++next_tag;

            EncodeRequest req;
            req.pts_us = last_pts;
            req.tag = tag;
            req.force_idr = submit_idr;
            req.refinement = refinement;
            req.bitrate_bps = rate;
            req.mb_info = (!refinement && !submit_idr) ? p.mb_info.data() : nullptr;
            req.native_handle = native_handle;
            req.damage = refinement ? nullptr : &rects;

            std::string submit_error;
            if (!p.controller.active().submit(req, submit_error)) {
              const EncoderDecision decision = p.controller.onSubmitFailure(submit_error, submit_idr);
              syncEncoderStats(p.controller);
              if (decision.action == EncoderAction::fatal) {
                throw std::runtime_error("encoder submit failed: " + decision.message);
              }
              std::vector<EncodeResult> discarded;
              p.controller.active().flush(discarded);
              pending_jobs.clear();
              dirty = true;
              force_idr = true;
              reset_refinement();
              if (!decision.switched_to_software) {
                retry_after = Clock::now() + std::chrono::milliseconds(200);
              }
              continue;
            }

            pending_jobs.push_back(SubmittedJob{
                tag, gen, rev, last_pts, captured_frame, submit_idr, refinement,
                ns(captured - capture_start), ns(converted - captured),
            });
            force_idr = false;
            bucket.spend(int64_t(ns(Clock::now().time_since_epoch())));
            drain_results(false);
          } catch (const std::exception& error) {
            std::fprintf(stderr, "capture: %s; retrying with IDR\n", error.what());
            dirty = true;
            force_idr = true;
            reset_refinement();
            pending_jobs.clear();
            if (++consecutive_capture_failures >= 3) {
              throw std::runtime_error(std::string("capture failed three consecutive times: ") + error.what());
            }
            p.controller.resetForCaptureError();
            retry_after = Clock::now() + std::chrono::seconds(1);
          }
          continue;
        }

        if (cursor_published) continue;

        int64_t timeout_ns = -1;
        auto add_wait = [&](int64_t candidate) {
          if (candidate >= 0 && (timeout_ns < 0 || candidate < timeout_ns)) timeout_ns = candidate;
        };
        if (admitted) {
          if (dirty) {
            add_wait(std::max<int64_t>(retry_after > now ? int64_t(ns(retry_after - now)) : 0, bucket.wait_ns(now_ns)));
          } else if (refinement_pending && queue_empty) {
            const auto due = std::max(retry_after, last_publish + refinement_pace);
            add_wait(std::max<int64_t>(due > now ? int64_t(ns(due - now)) : 0, bucket.wait_ns(now_ns)));
          }
        }
        const WaitReady ready_events = wait(damage_fd, wake_event, timeout_ns);
        if (ready_events.wake) wake_event.consume();
      }

      std::vector<EncodeResult> final_discard;
      p.controller.active().flush(final_discard);
      {
        std::lock_guard<std::mutex> lock(mutex);
        running = false;
      }
    } catch (const std::exception& error) {
      std::fprintf(stderr, "capture worker stopped: %s\n", error.what());
      {
        std::lock_guard<std::mutex> lock(mutex);
        if (!initialized) startup_error = error.what();
        else fatal_error = error.what();
        initialized = true;
        running = false;
      }
      ready.notify_all();
    }
  }
};

CaptureEncoder::CaptureEncoder(Publish publish, CaptureSettings settings, CaptureSourceFactory factory,
                               PublishCursor publish_cursor, EncoderFactories encoder_factories)
    : impl_(std::make_unique<Impl>(std::move(publish), std::move(settings), std::move(factory),
                                   std::move(publish_cursor), std::move(encoder_factories))) {}

CaptureEncoder::~CaptureEncoder() { stop(); }

bool CaptureEncoder::start(std::string& error) {
  auto& i = *impl_;
  i.worker = std::thread([&i] { i.run(); });
  std::unique_lock<std::mutex> lock(i.mutex);
  i.ready.wait(lock, [&i] { return i.initialized; });
  if (!i.running) {
    error = i.startup_error;
    lock.unlock();
    if (i.worker.joinable()) i.worker.join();
    return false;
  }
  return true;
}

void CaptureEncoder::beginSession(uint32_t generation) {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  i.generation = generation;
  i.sequence = 0;
  i.acknowledged = 0;
  i.window = 1;
  i.bitrate = i.settings.start_bitrate;
  i.admit_until_us = 0;
  i.paused = false;
  i.active = true;
  ++i.revision;
  i.wake();
}

void CaptureEncoder::endSession(uint32_t generation) {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  if (i.generation != generation) return;
  i.generation = 0;
  i.active = false;
  ++i.revision;
  i.wake();
}

void CaptureEncoder::acknowledge(uint32_t generation, uint32_t sequence) {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  if (i.generation != generation || sequence <= i.acknowledged) return;
  i.acknowledged = sequence;
  i.wake();
}

void CaptureEncoder::setFlowControl(uint32_t generation, unsigned window, uint64_t bitrate, bool paused, uint64_t admit_until_us) {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  if (i.generation != generation || !i.active) return;
  i.window = std::max(1u, window);
  i.bitrate = std::clamp(bitrate, i.settings.min_bitrate, i.settings.max_bitrate);
  i.paused = paused;
  i.admit_until_us = admit_until_us;
  i.wake();
}

void CaptureEncoder::requestKeyframe() {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  i.keyframe_requested = true;
  i.wake();
}

CaptureStats CaptureEncoder::stats() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->counters;
}

std::string CaptureEncoder::error() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->fatal_error;
}

void CaptureEncoder::stop() {
  if (!impl_) return;
  auto& i = *impl_;
  {
    std::lock_guard<std::mutex> lock(i.mutex);
    i.stopping = true;
    i.active = false;
  }
  i.wake();
  if (i.worker.joinable()) i.worker.join();
}

}  // namespace relay
