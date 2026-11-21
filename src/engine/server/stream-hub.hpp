#pragma once

#include "core/capture.hpp"
#include "core/flow.hpp"
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace relay {

/** Explicit lifecycle state of the single shared encoding pipeline. */
enum class HubState : uint8_t { stopped, idle, streaming, failed };

/** Explicit per-subscriber delivery state inside StreamHub. */
enum class ViewerState : uint8_t { disconnected, awaiting_idr, streaming, closing };

/** Returns a stable lowercase name for a HubState value. */
const char* hubStateName(HubState state);

/** Returns a stable lowercase name for a ViewerState value. */
const char* viewerStateName(ViewerState state);

/** Role of a subscriber attached to StreamHub. */
enum class SubscriberRole : uint8_t { controller, watch, rtc };

/** Queued frame paired with the subscriber's own monotonic wire sequence number. */
struct ViewerPacket {
  uint32_t sequence = 0;
  std::shared_ptr<const EncodedFrame> frame;
};

/** Transport-independent shared stream broadcaster owning one CaptureEncoder for all viewers. */
class StreamHub {
 public:
  using WakeCallback = std::function<void()>;
  using RtcSink = std::function<void(const std::shared_ptr<const EncodedFrame>&, uint32_t generation, uint32_t sequence)>;

  struct SubscriberSinks {
    RtcSink frame;
    std::function<void(uint32_t generation, const CursorImage&)> cursor;
    std::function<void(uint32_t generation)> clipboard;
  };

  struct Subscriber {
    uint64_t id = 0;
    SubscriberRole role = SubscriberRole::watch;
    ViewerState state = ViewerState::disconnected;
    uint32_t generation = 0;
    uint32_t wire_sequence = 0;
    uint32_t last_sent_sequence = 0;
    uint64_t attached_us = 0;
    uint64_t awaiting_idr_since_us = 0;
    uint64_t keyframe_requested_us = 0;
    FlowControl flow;
    std::deque<ViewerPacket> pending;
    std::optional<CursorImage> pending_cursor;
    bool last_write_cursor = false;
    bool clipboard_notices = false;
    bool clipboard_pending = false;
    bool failed = false;
    size_t buffered_bytes = 0;
    uint32_t notsent_lowat = 0;
    uint64_t flow_timer_due_us = 0;
    std::vector<uint8_t> received;
    std::deque<std::pair<uint32_t, uint32_t>> wire_to_encoder_seq;
    SubscriberSinks sinks;
  };

  StreamHub(CaptureSettings settings, CaptureSourceFactory factory, WakeCallback wake,
            EncoderFactories encoder_factories = {});
  ~StreamHub();
  StreamHub(const StreamHub&) = delete;
  StreamHub& operator=(const StreamHub&) = delete;

  /** Starts the single capture and encode worker; transitions stopped -> idle. */
  bool start(std::string& error);
  /** Stops the capture and encode worker and clears all subscribers; transitions to stopped. */
  void stop();

  /** Attaches a subscriber; transitions idle -> streaming on first attach, or requests an IDR on join. */
  std::shared_ptr<Subscriber> attach(SubscriberRole role, uint32_t viewer_generation, bool clipboard_notices,
                                     SubscriberSinks sinks = {});
  /** Detaches a subscriber; seamlessly hands off flow control or transitions streaming -> idle when empty. */
  void detach(uint64_t subscriber_id);

  /** Updates a subscriber's flow control and forwards the driver's limits to the single encoder. */
  void updateFlow(const std::shared_ptr<Subscriber>& sub, uint64_t now_us,
                  const std::optional<FlowControl::TransportSample>& sample,
                  unsigned& out_window, uint64_t& out_deadline_us, uint32_t& out_lowat);

  /** Records a viewer ACK for sequence; advances encoder admission when this subscriber drives flow control. */
  bool acknowledge(const std::shared_ptr<Subscriber>& sub, uint32_t viewer_generation, uint32_t sequence,
                   uint64_t now_us, uint64_t wait_us);

  /** Requests an IDR on the shared encoder without restarting the capture session. */
  void requestKeyframe();
  void notifyClipboard();

  /** Pops the next cursor or video packet ready to write for sub; returns false if nothing is queued. */
  bool popOutbound(const std::shared_ptr<Subscriber>& sub, std::optional<ViewerPacket>& packet,
                   std::optional<CursorImage>& cursor, bool& failed, bool& more_pending);
  /** Records that sequence was handed to the socket so FlowControl can track wire age. */
  bool markSent(const std::shared_ptr<Subscriber>& sub, uint32_t sequence, uint64_t now_us);

  /** Reports whether this subscriber has timed out or encountered a fatal capture error. */
  bool timedOut(const std::shared_ptr<Subscriber>& sub, uint64_t now_us) const;

  /** Returns JSON flow metrics for the primary active subscriber (or default idle values). */
  std::string primaryMetrics(uint64_t now_us) const;
  std::string metricsFor(const std::shared_ptr<Subscriber>& sub, uint64_t now_us) const;

  HubState state() const;
  ViewerState viewerState(const std::shared_ptr<Subscriber>& sub) const;
  size_t subscriberCount() const;
  CaptureStats stats() const;
  std::string error() const;
  std::string profileLevelId() const;

 private:
  bool onFrame(std::shared_ptr<const EncodedFrame> frame);
  void onCursor(uint32_t encoder_gen, CursorImage&& cursor);
  uint32_t nextGenerationLocked();
  uint64_t driverIdLocked(uint64_t now_us) const;
  void dropUnsentLocked(Subscriber& sub);
  void pushDriverFlowLocked(uint64_t now_us, uint64_t driver_id, uint32_t& enc_gen, unsigned& window,
                            uint64_t& bitrate, bool& paused, uint64_t& admit_until, bool& should_push) const;

  CaptureSettings settings_;
  WakeCallback wake_;
  CaptureEncoder capture_;
  mutable std::mutex mutex_;
  HubState state_ = HubState::stopped;
  uint32_t encoder_generation_ = 0;
  uint32_t last_encoder_seq_ = 0;
  uint64_t active_driver_id_ = 0;
  uint64_t last_non_controller_idr_us_ = 0;
  uint64_t next_subscriber_id_ = 0;
  std::vector<std::shared_ptr<Subscriber>> subscribers_;
};

}  // namespace relay
