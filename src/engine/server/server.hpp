#pragma once

#include "clipboard.hpp"
#include "config.hpp"
#include "core/capture.hpp"
#include "core/flow.hpp"
#include "core/input.hpp"
#include "screenshot.hpp"
#include "wire.hpp"
#include <libwebsockets.h>
#include <array>
#include <atomic>
#include <deque>
#include <functional>
#include <set>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace relay {
struct HttpResponse {
  unsigned char body[2048], input[max_input_batch * 16];
  size_t length, input_length, input_expected;
  std::vector<uint8_t>* image;
  std::string* upload;
  size_t offset;
  Socket socket;
  uint64_t upload_expected, grant_id;
  bool image_headers, clipboard, input_reply, input_headers, closing;
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
  /// Context the input thread may wake; it is set and cleared under this mutex so a fence never wakes a destroyed context.
  struct InputWake {
    void set(lws_context* next);
    void cancel();
    std::mutex mutex;
    lws_context* context = nullptr;
  };
  struct Stream {
    lws* viewer = nullptr;
    std::mutex mutex;
    std::deque<EncodedFrame> pending;
    std::optional<CursorImage> pending_cursor;
    bool last_write_cursor = false;
    bool clipboard_notices = false, clipboard_pending = false;
    size_t buffered_stream_bytes = 0;
    uint32_t stream_notsent_lowat = 0;
    uint64_t flow_timer_due_us = 0;
    FlowControl flow;
    uint32_t generation = 0, superseded = 0, lastSequence = 0;
    uint16_t width = 0, height = 0;
    bool failed = false;
    std::atomic<bool> resized{false};
    std::vector<uint8_t> received;
    CaptureEncoder capture;
    explicit Stream(Server& server);
    void begin(lws* wsi, uint32_t gen);
    /** Starts generation gen on the open connection at the capture's new size. */
    void restart(uint32_t gen);
    void end();
    void updateFlow(bool proxy);
    bool timedOut();
    std::string metrics();
    int write(bool proxy);
  };
  Config config;
  Grants grants;
  lws_context* context = nullptr;
  std::array<std::unique_ptr<Stream>, max_viewers> streams;
  lws* input_viewer = nullptr;
  lws* control = nullptr;
  /// Sockets that connectionPlan closed; each closes with its close code on its next timer callback.
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
  std::shared_ptr<InputWake> wake = std::make_shared<InputWake>();
  std::unique_ptr<InputController> input;
  uint32_t nextGeneration = 0;
  uint16_t width = 0, height = 0;
  explicit Server(Config settings);
  Stream* streamFor(lws* wsi);
  ConnectionPlan planConnection(Socket socket, bool grant);
  int startStream(lws* wsi, Socket socket, const ConnectionPlan& plan, bool clipboardNotices);
  void release();
  void endStream(lws* wsi);
  void endControl();
  void end();
  void expireGrants();
  /// Sends a close code from the timer callback; the default is the takeover code.
  void evict(lws* wsi, uint16_t code = close_taken, const char* reason = "taken");
  bool holdsInput() const { return control || input_viewer; }
  bool streamMessage(Stream& stream);
  bool controlMessage();
  std::string metrics();
  /// Holds the HTTP response until the backend applied or dropped the batch; posted counts records that reached it.
  int deferInput(lws* wsi, InputStatus status, size_t applied, size_t posted);
  std::vector<std::shared_ptr<InputReply>> readyInputs();
  void forgetInput(lws* wsi);
  int writeControl(lws* wsi);
};
int callback(lws* wsi, lws_callback_reasons reason, void* user, void* in, size_t len);
}  // namespace relay
