#include "rtc.hpp"
#ifdef RELAY_RTC
#include <rtc/rtc.hpp>
#endif
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>
#include <variant>

namespace relay {

const char* rtcStateName(RtcState state) {
  switch (state) {
    case RtcState::idle: return "idle";
    case RtcState::gathering: return "gathering";
    case RtcState::connecting: return "connecting";
    case RtcState::connected: return "connected";
    case RtcState::closing: return "closing";
    case RtcState::closed: return "closed";
  }
  return "unknown";
}

bool RtcAnswerGate::begin() {
  if (state_ != RtcAnswerState::idle) return false;
  state_ = RtcAnswerState::pending;
  answer_sdp_.clear();
  error_.clear();
  return true;
}

void RtcAnswerGate::resolve(std::string sdp) {
  if (state_ != RtcAnswerState::pending) return;
  answer_sdp_ = std::move(sdp);
  error_.clear();
  state_ = RtcAnswerState::answered;
}

void RtcAnswerGate::reject(std::string reason) {
  if (state_ != RtcAnswerState::pending) return;
  error_ = reason.empty() ? std::string("rtc_failed") : std::move(reason);
  answer_sdp_.clear();
  state_ = RtcAnswerState::failed;
}

RtcAnswerState RtcAnswerGate::state() const { return state_; }

bool RtcAnswerGate::settled() const {
  return state_ == RtcAnswerState::answered || state_ == RtcAnswerState::failed;
}

bool RtcAnswerGate::take(std::string& answer_sdp, std::string& error) const {
  if (!settled()) return false;
  answer_sdp = answer_sdp_;
  error = error_;
  return true;
}

namespace {
#ifdef RELAY_RTC
constexpr uint32_t video_ssrc = 0x52454c59;
constexpr size_t max_queued_rtc_input = 1024;
constexpr size_t max_queued_rtc_frames = 4;
constexpr size_t max_queued_rtc_acks = 256;
constexpr size_t event_header_size = 20;
constexpr uint32_t event_magic = 0x4e534c31;
enum class EventType : uint8_t { frame = 1, ack = 2, cursor = 6, clipboard = 7 };
constexpr auto rtc_disconnect_grace = std::chrono::seconds(4);
constexpr auto rtc_overrun_idr_interval = std::chrono::seconds(1);

uint32_t readBigEndian(const std::byte* src, size_t size) {
  uint32_t value = 0;
  for (size_t i = 0; i < size; ++i) value = (value << 8) | std::to_integer<uint32_t>(src[i]);
  return value;
}

void writeBigEndian(std::byte* dest, uint32_t value, size_t size) {
  while (size) {
    dest[--size] = std::byte(value & 0xff);
    value >>= 8;
  }
}

rtc::binary eventMessage(EventType type, uint32_t generation, uint32_t sequence = 0, uint32_t size = 0) {
  rtc::binary message(event_header_size + size);
  writeBigEndian(message.data(), event_magic, 4);
  message[4] = std::byte{1};
  message[5] = std::byte(type);
  writeBigEndian(message.data() + 8, generation, 4);
  writeBigEndian(message.data() + 12, sequence, 4);
  writeBigEndian(message.data() + 16, size, 4);
  return message;
}

std::optional<RtcAck> parseAck(const rtc::binary& message) {
  if ((message.size() != event_header_size && message.size() != event_header_size + 4) ||
      readBigEndian(message.data(), 4) != event_magic || message[4] != std::byte{1} ||
      message[5] != std::byte(EventType::ack) || readBigEndian(message.data() + 6, 2) != 0 ||
      readBigEndian(message.data() + 16, 4) != message.size() - event_header_size) return std::nullopt;
  RtcAck ack{readBigEndian(message.data() + 8, 4), readBigEndian(message.data() + 12, 4),
             message.size() == event_header_size + 4 ? readBigEndian(message.data() + event_header_size, 4) : 0};
  if (!ack.generation || !ack.sequence) return std::nullopt;
  return ack;
}

std::optional<rtc::binary> cursorEvent(uint32_t generation, const CursorImage& cursor) {
  if (cursor.width > CursorImage::max_extent || cursor.height > CursorImage::max_extent ||
      cursor.rgba.size() != size_t(cursor.width) * cursor.height * 4 ||
      (cursor.width && cursor.height ? cursor.xhot >= cursor.width || cursor.yhot >= cursor.height
                                     : cursor.width || cursor.height || cursor.xhot || cursor.yhot)) return std::nullopt;
  auto message = eventMessage(EventType::cursor, generation, 0, uint32_t(8 + cursor.rgba.size()));
  auto* payload = message.data() + event_header_size;
  writeBigEndian(payload, cursor.width, 2);
  writeBigEndian(payload + 2, cursor.height, 2);
  writeBigEndian(payload + 4, cursor.xhot, 2);
  writeBigEndian(payload + 6, cursor.yhot, 2);
  if (!cursor.rgba.empty()) std::memcpy(payload + 8, cursor.rgba.data(), cursor.rgba.size());
  return message;
}

bool isHexDigit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

std::string normalizeProfileLevelId(const std::string& raw) {
  if (raw.size() != 6 || !std::all_of(raw.begin(), raw.end(), isHexDigit)) return {};
  std::string out = raw;
  for (char& c : out) if (c >= 'A' && c <= 'F') c = char(c - 'A' + 'a');
  return out;
}

std::string lowercase(std::string text) {
  for (char& c : text) if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
  return text;
}

std::string extractFmtpProfileLevelId(const std::string& fmtp) {
  const std::string key = "profile-level-id=";
  const auto pos = fmtp.find(key);
  if (pos == std::string::npos || pos + key.size() + 6 > fmtp.size()) return {};
  return normalizeProfileLevelId(fmtp.substr(pos + key.size(), 6));
}

struct H264OfferChoice {
  int pt = -1;
  std::string plid;
};

/** Selects the H.264 payload type and profile-level-id from an offer video section matching packetization-mode=1. */
H264OfferChoice h264PayloadType(const rtc::Description::Media& media, const std::string& preferred_plid) {
  H264OfferChoice fallback_42e0;
  H264OfferChoice fallback_any;
  for (const int pt : media.payloadTypes()) {
    const auto* map = media.rtpMap(pt);
    if (!map || map->format != "H264") continue;
    std::string fmtp;
    for (const auto& f : map->fmtps) fmtp += lowercase(f) + ";";
    if (fmtp.find("packetization-mode=1") == std::string::npos) continue;
    const std::string plid = extractFmtpProfileLevelId(fmtp);
    if (!preferred_plid.empty() && plid == preferred_plid) return {pt, plid};
    if (fallback_42e0.pt < 0 && plid == "42e01f") fallback_42e0 = {pt, plid};
    if (fallback_any.pt < 0) fallback_any = {pt, plid};
  }
  return fallback_42e0.pt >= 0 ? fallback_42e0 : fallback_any;
}
#endif
}  // namespace

struct RtcSession::Impl : public std::enable_shared_from_this<Impl> {
  using Clock = std::chrono::steady_clock;
  std::vector<IceServer> ice_servers;
  bool can_send_input = false;
  bool can_receive_clipboard = false;
  RtcCallbacks callbacks;
  mutable std::mutex mutex;
  std::condition_variable cv;
  std::condition_variable send_cv;
  std::thread gather_thread;
  std::thread send_thread;
  RtcState state = RtcState::idle;
  RtcAnswerGate answer;
  bool ever_connected = false;
  bool awaiting_keyframe = true;
  bool gathering_complete = false;
  std::optional<Clock::time_point> disconnected_at;
  Clock::time_point last_overrun_idr{};
  std::deque<std::array<uint8_t, 16>> input;
  std::deque<RtcAck> ack_queue;
  struct PendingFrame {
    std::shared_ptr<const EncodedFrame> frame;
    uint32_t generation;
    uint32_t sequence;
  };
  std::deque<PendingFrame> pending_frames;
  std::optional<std::pair<uint32_t, CursorImage>> pending_cursor;
  std::optional<uint32_t> pending_clipboard_gen;
#ifdef RELAY_RTC
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::Track> track;
  std::shared_ptr<rtc::DataChannel> channel;
  std::shared_ptr<rtc::DataChannel> events_channel;
  bool events_ready = false;
#endif

  Impl(std::vector<IceServer> servers, bool allow_input, bool allow_clipboard, RtcCallbacks cb)
      : ice_servers(std::move(servers)), can_send_input(allow_input), can_receive_clipboard(allow_clipboard),
        callbacks(std::move(cb)) {}

  void wake() const {
    if (callbacks.wake) callbacks.wake();
  }

  void join() {
    if (gather_thread.joinable() && gather_thread.get_id() != std::this_thread::get_id()) {
      gather_thread.join();
    }
    if (send_thread.joinable() && send_thread.get_id() != std::this_thread::get_id()) {
      send_thread.join();
    }
  }

  void fail(const std::string& reason) {
#ifdef RELAY_RTC
    std::shared_ptr<rtc::DataChannel> dc, events;
    std::shared_ptr<rtc::Track> tr;
    std::shared_ptr<rtc::PeerConnection> peer;
#endif
    {
      std::lock_guard<std::mutex> lock(mutex);
      answer.reject(reason);
      state = RtcState::closed;
      disconnected_at.reset();
      pending_frames.clear();
#ifdef RELAY_RTC
      dc = std::move(channel);
      events = std::move(events_channel);
      tr = std::move(track);
      peer = std::move(pc);
#endif
      cv.notify_all();
      send_cv.notify_all();
    }
#ifdef RELAY_RTC
    if (dc) dc->close();
    if (events) events->close();
    if (tr) tr->close();
    if (peer) peer->close();
#endif
    wake();
  }

  void close() {
#ifdef RELAY_RTC
    std::shared_ptr<rtc::DataChannel> dc, events;
    std::shared_ptr<rtc::Track> tr;
    std::shared_ptr<rtc::PeerConnection> peer;
#endif
    {
      std::lock_guard<std::mutex> lock(mutex);
      answer.reject("rtc_closed");
#ifdef RELAY_RTC
      dc = std::move(channel);
      events = std::move(events_channel);
      tr = std::move(track);
      peer = std::move(pc);
#endif
      if (state != RtcState::closed) {
        state = RtcState::closing;
        state = RtcState::closed;
        disconnected_at.reset();
        pending_frames.clear();
        cv.notify_all();
        send_cv.notify_all();
      }
    }
#ifdef RELAY_RTC
    if (dc) dc->close();
    if (events) events->close();
    if (tr) tr->close();
    if (peer) peer->close();
#endif
    wake();
  }

  void startOffer(std::string offer_sdp) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (state != RtcState::idle) return;
      answer = RtcAnswerGate{};
      answer.begin();
      ever_connected = false;
      state = RtcState::gathering;
      awaiting_keyframe = true;
      gathering_complete = false;
      disconnected_at.reset();
      pending_frames.clear();
    }
    auto self = shared_from_this();
#ifdef RELAY_RTC
    auto sender_self = shared_from_this();
    send_thread = std::thread([sender_self = std::move(sender_self)] { sender_self->sendLoop(); });
#endif
    gather_thread = std::thread([self = std::move(self), offer = std::move(offer_sdp)]() mutable {
      self->runOffer(std::move(offer));
    });
  }

#ifdef RELAY_RTC
  void sendLoop() {
    while (true) {
      PendingFrame pending{};
      std::optional<std::pair<uint32_t, CursorImage>> cursor;
      std::optional<uint32_t> clipboard_gen;
      std::shared_ptr<rtc::Track> tr;
      std::shared_ptr<rtc::DataChannel> events;
      {
        std::unique_lock<std::mutex> lock(mutex);
        send_cv.wait(lock, [this] {
          return state == RtcState::closed || state == RtcState::closing || !pending_frames.empty() ||
              (events_ready && (pending_cursor || pending_clipboard_gen));
        });
        if (state == RtcState::closed || state == RtcState::closing) return;
        if (!pending_frames.empty()) {
          pending = std::move(pending_frames.front());
          pending_frames.pop_front();
          if (state == RtcState::connected) tr = track;
        }
        if (events_ready) {
          events = events_channel;
          cursor = std::exchange(pending_cursor, std::nullopt);
          clipboard_gen = std::exchange(pending_clipboard_gen, std::nullopt);
        }
      }
      try {
        if (pending.frame && tr && tr->isOpen()) {
          const auto& frame = *pending.frame;
          tr->sendFrame(reinterpret_cast<const std::byte*>(frame.annex_b.data()), frame.annex_b.size(),
                        rtc::FrameInfo(std::chrono::duration<double, std::micro>(double(frame.pts_us))));
          if (events && events->isOpen()) events->send(eventMessage(EventType::frame, pending.generation, pending.sequence));
        }
      } catch (const std::exception& ex) {
        std::cerr << "RTC send failed: " << ex.what() << '\n';
      }
      if (!events || !events->isOpen()) continue;
      try {
        if (cursor) {
          if (auto message = cursorEvent(cursor->first, cursor->second)) events->send(std::move(*message));
        }
        if (clipboard_gen) events->send(eventMessage(EventType::clipboard, *clipboard_gen));
      } catch (const std::exception& ex) {
        std::cerr << "RTC send failed: " << ex.what() << '\n';
      }
    }
  }

  void acceptEventsChannel(const std::shared_ptr<rtc::DataChannel>& dc, const std::weak_ptr<Impl>& weak) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (state == RtcState::closed || state == RtcState::closing || events_channel) return;
      events_channel = dc;
    }
    dc->onMessage([weak](rtc::message_variant message) {
      auto self = weak.lock();
      const auto* bytes = std::get_if<rtc::binary>(&message);
      if (!self || !bytes) return;
      const auto ack = parseAck(*bytes);
      if (!ack) return;
      {
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->state == RtcState::closed || self->state == RtcState::closing) return;
        if (self->ack_queue.size() >= max_queued_rtc_acks) self->ack_queue.pop_front();
        self->ack_queue.push_back(*ack);
      }
      self->wake();
    });
    auto opened = [weak] {
      if (auto self = weak.lock()) {
        {
          std::lock_guard<std::mutex> lock(self->mutex);
          if (self->events_ready || self->state == RtcState::closed || self->state == RtcState::closing) return;
          self->events_ready = true;
          self->send_cv.notify_one();
        }
        if (self->callbacks.request_keyframe) self->callbacks.request_keyframe();
      }
    };
    dc->onOpen(opened);
    dc->onClosed([weak] {
      if (auto self = weak.lock()) {
        std::lock_guard<std::mutex> lock(self->mutex);
        self->events_ready = false;
      }
    });
    if (dc->isOpen()) opened();
  }
#endif

  void runOffer(std::string offer_sdp) {
#ifndef RELAY_RTC
    (void)offer_sdp;
    fail("rtc_disabled");
#else
    try {
      rtc::Description offer(offer_sdp, rtc::Description::Type::Offer);
      std::string preferred_plid;
      if (callbacks.profile_level_id) {
        preferred_plid = normalizeProfileLevelId(callbacks.profile_level_id());
      }

      std::string mid;
      H264OfferChoice choice;
      for (int i = 0; i < offer.mediaCount(); ++i) {
        const auto entry = offer.media(i);
        if (!std::holds_alternative<rtc::Description::Media*>(entry)) continue;
        const auto* media = std::get<rtc::Description::Media*>(entry);
        if (!media || media->type() != "video") continue;
        mid = media->mid();
        choice = h264PayloadType(*media, preferred_plid);
        break;
      }
      if (mid.empty() || choice.pt < 0) {
        fail("no_h264");
        return;
      }
      const std::string answer_plid = !choice.plid.empty() ? choice.plid
                                    : (!preferred_plid.empty() ? preferred_plid : std::string("42e01f"));

      rtc::Configuration config;
      config.disableAutoNegotiation = false;
      for (const auto& server : ice_servers) {
        try {
          config.iceServers.emplace_back(server.raw);
        } catch (const std::exception& ex) {
          std::cerr << "Skipping unsupported ICE server entry: " << ex.what() << '\n';
        }
      }

      auto peer = std::make_shared<rtc::PeerConnection>(config);
      rtc::Description::Video video(mid, rtc::Description::Direction::SendOnly);
      video.addH264Codec(choice.pt, "profile-level-id=" + answer_plid + ";packetization-mode=1;level-asymmetry-allowed=1");
      video.addSSRC(video_ssrc, "relay");
      auto tr = peer->addTrack(video);
      auto rtp = std::make_shared<rtc::RtpPacketizationConfig>(video_ssrc, "relay", uint8_t(choice.pt), rtc::H264RtpPacketizer::ClockRate);
      auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, rtp);
      packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(rtp));
      packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());

      std::weak_ptr<Impl> weak = shared_from_this();
      packetizer->addToChain(std::make_shared<rtc::PliHandler>([weak] {
        if (auto self = weak.lock()) {
          {
            std::lock_guard<std::mutex> lock(self->mutex);
            if (self->state == RtcState::closed || self->state == RtcState::closing) return;
            self->awaiting_keyframe = true;
          }
          if (self->callbacks.request_keyframe) self->callbacks.request_keyframe();
        }
      }));
      tr->setMediaHandler(packetizer);
      tr->onOpen([weak] {
        if (auto self = weak.lock()) {
          {
            std::lock_guard<std::mutex> lock(self->mutex);
            if (self->state == RtcState::closed || self->state == RtcState::closing) return;
            self->state = RtcState::connected;
            self->disconnected_at.reset();
            self->awaiting_keyframe = true;
          }
          if (self->callbacks.request_keyframe) self->callbacks.request_keyframe();
          self->wake();
        }
      });

      peer->onDataChannel([weak](std::shared_ptr<rtc::DataChannel> dc) {
        auto self = weak.lock();
        if (!self || !dc) return;
        const auto label = dc->label();
        if (label == "events") {
          self->acceptEventsChannel(dc, weak);
          return;
        }
        if (label != "input" || !self->can_send_input) return;
        {
          std::lock_guard<std::mutex> lock(self->mutex);
          if (self->state == RtcState::closed || self->state == RtcState::closing) return;
          self->channel = dc;
        }
        dc->onMessage([weak](rtc::message_variant message) {
          auto self = weak.lock();
          if (!self || !std::holds_alternative<rtc::binary>(message)) return;
          const auto& bytes = std::get<rtc::binary>(message);
          if (bytes.size() != 16) return;
          std::array<uint8_t, 16> record{};
          std::memcpy(record.data(), bytes.data(), 16);
          {
            std::lock_guard<std::mutex> lock(self->mutex);
            if (self->state == RtcState::closed || self->state == RtcState::closing) return;
            if (self->input.size() < max_queued_rtc_input) self->input.push_back(record);
          }
          self->wake();
        });
      });

      peer->onStateChange([weak](rtc::PeerConnection::State s) {
        auto self = weak.lock();
        if (!self) return;
        bool should_wake = false;
        {
          std::lock_guard<std::mutex> lock(self->mutex);
          if (self->state == RtcState::closed || self->state == RtcState::closing) return;
          if (s == rtc::PeerConnection::State::Connected) {
            self->state = RtcState::connected;
            self->ever_connected = true;
            self->disconnected_at.reset();
            should_wake = true;
          } else if (s == rtc::PeerConnection::State::Disconnected) {
            if (!self->disconnected_at) self->disconnected_at = Clock::now();
            should_wake = true;
          } else if (s == rtc::PeerConnection::State::Failed || s == rtc::PeerConnection::State::Closed) {
            self->answer.reject("rtc_failed");
            self->state = RtcState::closed;
            self->disconnected_at.reset();
            self->pending_frames.clear();
            self->cv.notify_all();
            self->send_cv.notify_all();
            should_wake = true;
          }
        }
        if (should_wake) self->wake();
      });

      peer->onGatheringStateChange([weak](rtc::PeerConnection::GatheringState s) {
        if (s != rtc::PeerConnection::GatheringState::Complete) return;
        if (auto self = weak.lock()) {
          std::lock_guard<std::mutex> lock(self->mutex);
          self->gathering_complete = true;
          self->cv.notify_all();
        }
      });

      const auto abandon = [this, &peer] {
        {
          std::lock_guard<std::mutex> lock(mutex);
          answer.reject("rtc_failed");
        }
        peer->close();
        wake();
      };

      {
        std::unique_lock<std::mutex> lock(mutex);
        if (state == RtcState::closed || state == RtcState::closing) {
          lock.unlock();
          abandon();
          return;
        }
        pc = peer;
        track = tr;
      }

      peer->setRemoteDescription(offer);
      {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait_for(lock, std::chrono::seconds(2), [this] {
          return gathering_complete || state == RtcState::closed || state == RtcState::closing;
        });
        if (state == RtcState::closed || state == RtcState::closing) {
          lock.unlock();
          abandon();
          return;
        }
      }

      const auto local = peer->localDescription();
      if (!local) {
        fail("no_answer");
        return;
      }
      {
        std::unique_lock<std::mutex> lock(mutex);
        if (state == RtcState::closed || state == RtcState::closing) {
          lock.unlock();
          abandon();
          return;
        }
        answer.resolve(std::string(*local));
        if (state == RtcState::gathering) state = RtcState::connecting;
      }
      wake();
    } catch (const std::invalid_argument& ex) {
      std::cerr << "RTC offer rejected: " << ex.what() << '\n';
      fail("invalid_offer");
    } catch (const std::exception& ex) {
      std::cerr << "RTC offer failed: " << ex.what() << '\n';
      fail("rtc_failed");
    }
#endif
  }

  void pushFrame(const std::shared_ptr<const EncodedFrame>& frame, uint32_t generation, uint32_t sequence) {
#ifdef RELAY_RTC
    if (!frame) return;
    bool request_idr = false;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (state != RtcState::connected || !track || disconnected_at) return;
      if (awaiting_keyframe && !frame->keyframe) return;
      bool enqueue = true;
      if (pending_frames.size() >= max_queued_rtc_frames) {
        pending_frames.clear();
        if (!frame->keyframe) {
          awaiting_keyframe = true;
          enqueue = false;
          const auto now = Clock::now();
          if (now - last_overrun_idr >= rtc_overrun_idr_interval) {
            last_overrun_idr = now;
            request_idr = true;
          }
        }
      }
      if (enqueue) {
        if (frame->keyframe) awaiting_keyframe = false;
        pending_frames.push_back({frame, generation, sequence});
        send_cv.notify_one();
      }
    }
    if (request_idr && callbacks.request_keyframe) callbacks.request_keyframe();
#else
    (void)frame;
    (void)generation;
    (void)sequence;
#endif
  }

  void pushCursor(uint32_t generation, const CursorImage& cursor) {
#ifdef RELAY_RTC
    std::lock_guard<std::mutex> lock(mutex);
    if (state == RtcState::closed || state == RtcState::closing) return;
    pending_cursor.emplace(generation, cursor);
    send_cv.notify_one();
#else
    (void)generation;
    (void)cursor;
#endif
  }

  void pushClipboardNotice(uint32_t generation) {
#ifdef RELAY_RTC
    if (!can_receive_clipboard) return;
    std::lock_guard<std::mutex> lock(mutex);
    if (state == RtcState::closed || state == RtcState::closing) return;
    pending_clipboard_gen = generation;
    send_cv.notify_one();
#else
    (void)generation;
#endif
  }

  std::deque<RtcAck> takeAcks() {
    std::lock_guard<std::mutex> lock(mutex);
    return std::exchange(ack_queue, {});
  }

  bool takeAnswer(std::string& out_answer, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex);
    return answer.take(out_answer, out_error);
  }

  bool everConnected() const {
    std::lock_guard<std::mutex> lock(mutex);
    return ever_connected;
  }

  std::deque<std::array<uint8_t, 16>> takeInput() {
    std::lock_guard<std::mutex> lock(mutex);
    return std::exchange(input, {});
  }

  bool isClosed() const {
    std::lock_guard<std::mutex> lock(mutex);
    if (state == RtcState::closed) return true;
#ifdef RELAY_RTC
    if (disconnected_at && Clock::now() - *disconnected_at >= rtc_disconnect_grace) return true;
#endif
    return false;
  }
};

RtcSession::RtcSession(std::vector<IceServer> ice_servers, bool can_send_input, bool can_receive_clipboard,
                       RtcCallbacks callbacks)
    : impl_(std::make_shared<Impl>(std::move(ice_servers), can_send_input, can_receive_clipboard,
                                  std::move(callbacks))) {}

RtcSession::~RtcSession() {
  if (impl_) {
    impl_->close();
    impl_->join();
  }
}

void RtcSession::startOffer(std::string offer_sdp) { impl_->startOffer(std::move(offer_sdp)); }
bool RtcSession::takeAnswer(std::string& answer_sdp, std::string& error) { return impl_->takeAnswer(answer_sdp, error); }
void RtcSession::pushFrame(const std::shared_ptr<const EncodedFrame>& frame, uint32_t generation, uint32_t sequence) {
  impl_->pushFrame(frame, generation, sequence);
}
void RtcSession::pushCursor(uint32_t generation, const CursorImage& cursor) { impl_->pushCursor(generation, cursor); }
void RtcSession::pushClipboardNotice(uint32_t generation) { impl_->pushClipboardNotice(generation); }
std::deque<RtcAck> RtcSession::takeAcks() { return impl_->takeAcks(); }
std::deque<std::array<uint8_t, 16>> RtcSession::takeInput() { return impl_->takeInput(); }
void RtcSession::close() { impl_->close(); }
RtcState RtcSession::state() const { std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->state; }
bool RtcSession::canSendInput() const { return impl_->can_send_input && !impl_->isClosed(); }
bool RtcSession::canReceiveClipboard() const { return impl_->can_receive_clipboard && !impl_->isClosed(); }
bool RtcSession::closed() const { return impl_->isClosed(); }
bool RtcSession::everConnected() const { return impl_->everConnected(); }

}  // namespace relay
