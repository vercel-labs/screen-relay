#pragma once

#include "clipboard.hpp"
#include "config.hpp"
#include "core/input.hpp"
#include "screenshot.hpp"
#include "stream-hub.hpp"
#include "wire.hpp"
#ifdef RELAY_RTC
#include "rtc.hpp"
#endif
#include <libwebsockets.h>
#include <array>
#include <atomic>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace relay {

struct HttpResponse {
  unsigned char body[4096], input[max_input_batch * 16];
  size_t length, input_length, input_expected;
  std::vector<uint8_t>* image;
  std::string* upload;
  size_t offset;
  Socket socket;
  uint64_t upload_expected, grant_id, rtc_session_id;
  bool image_headers, clipboard, input_reply, input_headers, closing, rtc_offer;
  unsigned reply_status, image_status;
  const char* image_type;
};

struct Server {
  struct InputReply {
    lws* wsi = nullptr;
    unsigned status = 0;
    std::string body;
    std::atomic<bool> ready{false};
  };
  struct ControlReply {
    uint32_t seq = 0;
    InputStatus status = InputStatus::ok;
    std::atomic<bool> ready{false};
  };
  /** Mutex-guarded context wake handle so background threads never wake a destroyed lws_context. */
  struct InputWake {
    void set(lws_context* next);
    void cancel();
    std::mutex mutex;
    lws_context* context = nullptr;
  };
  /** WebSocket binding tying one lws client to a StreamHub::Subscriber. */
  struct ViewerSlot {
    lws* viewer = nullptr;
    std::shared_ptr<StreamHub::Subscriber> sub;
    uint16_t width = 0, height = 0;
  };

  Config config;
  Grants grants;
  lws_context* context = nullptr;
  std::shared_ptr<InputWake> wake = std::make_shared<InputWake>();
  StreamHub hub;
  std::array<ViewerSlot, max_viewers> viewers;
  lws* input_viewer = nullptr;
  lws* control = nullptr;
  /** Sockets scheduled to close with a status code on their next timer callback. */
  std::set<lws*> closing;
  Screenshot screenshot;
  lws* screenshot_client = nullptr;
  ClipboardWorker clipboard;
  std::atomic<bool> clipboard_changed{false};
  bool control_ready = false;
  uint32_t control_generation = 0;
  std::vector<uint8_t> control_received;
  std::deque<std::shared_ptr<ControlReply>> replies;
  std::mutex reply_mutex;
  std::deque<std::shared_ptr<InputReply>> input_replies;
  std::unique_ptr<InputController> input;
  uint32_t nextGeneration = 0;
  uint16_t width = 0, height = 0;
#ifdef RELAY_RTC
  /** Explicit stage of an in-flight POST /rtc offer before promotion to an active session. */
  enum class RtcOfferStage : uint8_t { none, receiving_body, gathering };
  struct ActiveRtcSession {
    uint64_t session_id = 0;
    std::shared_ptr<RtcSession> session;
    std::shared_ptr<StreamHub::Subscriber> sub;
    uint64_t subscriber_id = 0;
    uint64_t grant_id = 0;
    bool can_input = false;
    bool owns_input = false;
    bool can_receive_clipboard = false;
  };
  struct PendingRtcOffer {
    RtcOfferStage stage = RtcOfferStage::none;
    lws* client = nullptr;
    std::shared_ptr<RtcSession> session;
    uint64_t grant_id = 0;
    bool can_input = false;
  };
  struct RtcSlot {
    std::vector<ActiveRtcSession> active;
    PendingRtcOffer offer;
    uint64_t next_session_id = 0;
    bool hasOffer() const { return offer.stage != RtcOfferStage::none; }
  };
  RtcSlot rtc;
#endif

  explicit Server(Config settings);
  ViewerSlot* slotFor(lws* wsi);
  void wsViewerCounts(size_t& count, size_t& grantCount, bool& inputViewerHasGrant) const;
  ConnectionPlan planConnection(Socket socket, bool grant);
#ifdef RELAY_RTC
  RtcAdmission planRtcAdmission(uint64_t callerGrantId) const;
  void abortPendingRtc(bool evictClient, uint16_t code = LWS_CLOSE_STATUS_POLICY_VIOLATION,
                       const char* reason = "grant ended");
  void closeActiveRtc(size_t index);
  void assignRtcInput();
#endif
  int startStream(lws* wsi, Socket socket, const ConnectionPlan& plan, bool clipboardNotices);
  void updateSlotFlow(ViewerSlot& slot);
  int writeSlot(ViewerSlot& slot);
  void release();
  void endStream(lws* wsi, bool handoff = true);
  void endControl(bool handoff = true);
  void endRtc();
  void end();
  void expireGrants();
  /** Sends a close code from the timer callback; defaults to the takeover code. */
  void evict(lws* wsi, uint16_t code = close_taken, const char* reason = "taken");
  bool holdsInput() const;
  bool streamMessage(ViewerSlot& slot);
  bool controlMessage();
  std::string metrics();
  std::string rtcConfigJson() const;
  /** Holds the HTTP response until the input backend applies or drops the batch. */
  int deferInput(lws* wsi, InputStatus status, size_t applied, size_t posted);
  std::vector<std::shared_ptr<InputReply>> readyInputs();
  void forgetInput(lws* wsi);
  int writeControl(lws* wsi);
};

int callback(lws* wsi, lws_callback_reasons reason, void* user, void* in, size_t len);
}  // namespace relay
