#pragma once

#include "core/capture.hpp"
#include "ice.hpp"
#include <array>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace relay {

/** Explicit lifecycle states of one WebRTC viewer session. */
enum class RtcState : uint8_t { idle, gathering, connecting, connected, closing, closed };

/** Returns a stable lowercase name for an RtcState value. */
const char* rtcStateName(RtcState state);

/** Explicit lifecycle of one WebRTC offer's answer. */
enum class RtcAnswerState : uint8_t { idle, pending, answered, failed };

/** Single-use outcome gate for an RTC offer; the first answer or failure settles it permanently. */
class RtcAnswerGate {
 public:
  /** Opens the gate for one offer, returning false when an offer already started. */
  bool begin();
  /** Settles a pending gate with the answer SDP. */
  void resolve(std::string sdp);
  /** Settles a pending gate with a failure reason, defaulting to rtc_failed. */
  void reject(std::string reason);
  /** Returns the current gate state. */
  RtcAnswerState state() const;
  /** True once the gate holds an answer or a failure. */
  bool settled() const;
  /** Copies the settled outcome, returning false while the offer is still pending. */
  bool take(std::string& answer_sdp, std::string& error) const;

 private:
  RtcAnswerState state_ = RtcAnswerState::idle;
  std::string answer_sdp_;
  std::string error_;
};

/** Engine hooks invoked by RtcSession without coupling to libwebsockets or CaptureEncoder. */
struct RtcCallbacks {
  std::function<void()> wake;
  std::function<void()> request_keyframe;
  std::function<std::string()> profile_level_id;
};

struct RtcAck {
  uint32_t generation = 0;
  uint32_t sequence = 0;
  uint32_t wait_us = 0;
};

/** One opt-in WebRTC viewer sharing the engine's StreamHub encoder with STUN/TURN support. */
class RtcSession {
 public:
  RtcSession(std::vector<IceServer> ice_servers, bool can_send_input, bool can_receive_clipboard, RtcCallbacks callbacks);
  ~RtcSession();
  RtcSession(const RtcSession&) = delete;
  RtcSession& operator=(const RtcSession&) = delete;

  /** Begins asynchronous ICE gathering off the service thread and wakes on completion. */
  void startOffer(std::string offer_sdp);
  /** Returns true once the offer settles, populating either answer_sdp or error. */
  bool takeAnswer(std::string& answer_sdp, std::string& error);
  /** Sends a shared Annex B frame once the H.264 track is open, starting on a keyframe. */
  void pushFrame(const std::shared_ptr<const EncodedFrame>& frame, uint32_t generation, uint32_t sequence);
  void pushCursor(uint32_t generation, const CursorImage& cursor);
  void pushClipboardNotice(uint32_t generation);
  std::deque<RtcAck> takeAcks();
  /** Drains 16-byte input records received on the input data channel. */
  std::deque<std::array<uint8_t, 16>> takeInput();
  /** Transitions to closed and tears down the PeerConnection cleanly. */
  void close();
  RtcState state() const;
  bool canSendInput() const;
  bool canReceiveClipboard() const;
  bool closed() const;
  /** True once the peer connection has reached the connected state. */
  bool everConnected() const;

 private:
  struct Impl;
  std::shared_ptr<Impl> impl_;
};

}  // namespace relay
