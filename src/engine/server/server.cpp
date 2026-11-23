#include "server.hpp"
#include "backend.hpp"
#include "core/capture-source.hpp"
#include "metrics.hpp"
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <limits>
#ifdef __linux__
#include <sys/socket.h>
#include <netinet/in.h>
#include <linux/tcp.h>
#endif

namespace relay {
namespace {
using Clock = std::chrono::steady_clock;
uint64_t nowUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count();
}
/// Wakes the service thread once one deferred reply can be written.
class ReplyFence final : public InputFence {
 public:
  ReplyFence(std::shared_ptr<Server::InputWake> wake, std::function<void(bool, size_t)> mark)
      : wake(std::move(wake)), mark(std::move(mark)) {}
  void complete(bool applied, size_t dropped) override {
    mark(applied, dropped);
    wake->cancel();
  }
 private:
  std::shared_ptr<Server::InputWake> wake;
  std::function<void(bool, size_t)> mark;
};
#ifdef __linux__
void configureStreamSocket(lws* wsi) {
  const int fd = lws_get_socket_fd(wsi);
  if (fd < 0) return;
  const int enabled = 1;
  (void)setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
}
std::optional<FlowControl::TransportSample> streamTransportSample(lws* wsi, size_t buffered_bytes) {
  const int fd = lws_get_socket_fd(wsi);
  if (fd < 0) return std::nullopt;
  tcp_info info{};
  socklen_t length = sizeof(info);
  if (getsockopt(fd, IPPROTO_TCP, TCP_INFO, &info, &length) ||
      length < offsetof(tcp_info, tcpi_delivery_rate) + sizeof(info.tcpi_delivery_rate) ||
      !info.tcpi_min_rtt || info.tcpi_min_rtt == std::numeric_limits<uint32_t>::max()) return std::nullopt;
  FlowControl::TransportSample sample;
  sample.min_rtt_us = info.tcpi_min_rtt;
  sample.rtt_us = info.tcpi_rtt;
  sample.delivery_rate_bps = std::min<uint64_t>(info.tcpi_delivery_rate, std::numeric_limits<uint64_t>::max() / 8) * 8;
  sample.notsent_bytes = info.tcpi_notsent_bytes;
  sample.snd_cwnd = info.tcpi_snd_cwnd;
  sample.total_retrans = info.tcpi_total_retrans;
  sample.app_limited = info.tcpi_delivery_rate_app_limited;
  sample.bytes_acked = info.tcpi_bytes_acked;
  sample.application_queued_bytes = buffered_bytes;
  return sample;
}
#endif
}  // namespace
Server::Server(Config settings)
    : config(std::move(settings)),
      hub(CaptureSettings{config.fps, config.bitrate_min, config.bitrate_start, config.bitrate_max, config.encoder},
          backendFor(config.backend).capture,
          [w = wake] { w->cancel(); }) {}

Server::ViewerSlot* Server::slotFor(lws* wsi) {
  for (auto& slot : viewers) if (slot.viewer == wsi) return &slot;
  return nullptr;
}

bool Server::holdsInput() const {
#ifdef RELAY_RTC
  return control || input_viewer || std::any_of(rtc.active.begin(), rtc.active.end(),
      [](const ActiveRtcSession& session) { return session.owns_input; });
#else
  return control || input_viewer;
#endif
}

void Server::wsViewerCounts(size_t& count, size_t& grantCount, bool& inputViewerHasGrant) const {
  count = 0;
  grantCount = 0;
  inputViewerHasGrant = false;
  for (const auto& slot : viewers) {
    if (!slot.viewer) continue;
    ++count;
    const auto* response = static_cast<HttpResponse*>(lws_wsi_user(slot.viewer));
    const bool hasGrant = !response || response->grant_id;
    if (hasGrant) ++grantCount;
    if (slot.viewer == input_viewer) inputViewerHasGrant = hasGrant;
  }
}

ConnectionPlan Server::planConnection(Socket socket, bool grant) {
  size_t count = 0, grantCount = 0;
  bool inputViewerHasGrant = false;
  wsViewerCounts(count, grantCount, inputViewerHasGrant);
#ifdef RELAY_RTC
  bool rtc_owns_input = false;
  for (const auto& active : rtc.active) {
    ++count;
    if (active.grant_id) ++grantCount;
    if (active.owns_input) { rtc_owns_input = true; inputViewerHasGrant = active.grant_id != 0; }
  }
  if (rtc.hasOffer()) {
    ++count;
    if (rtc.offer.grant_id) ++grantCount;
  }
  const bool stream_owns_input = input_viewer != nullptr || rtc_owns_input;
#else
  const bool stream_owns_input = input_viewer != nullptr;
#endif
  if (control && grant && socket == Socket::take) {
    const auto* owner = static_cast<HttpResponse*>(lws_wsi_user(control));
    if (!owner || !owner->grant_id) return {};
  }
  return connectionPlan(socket, count, stream_owns_input, control != nullptr, grantCount, grant, inputViewerHasGrant);
}

#ifdef RELAY_RTC
RtcAdmission Server::planRtcAdmission(uint64_t callerGrantId) const {
  size_t wsCount = 0, wsGrantCount = 0;
  bool inputViewerHasGrant = false;
  wsViewerCounts(wsCount, wsGrantCount, inputViewerHasGrant);
  size_t rtcGrantCount = 0;
  bool replaceable = false;
  for (const auto& active : rtc.active) {
    if (active.grant_id) ++rtcGrantCount;
    if (callerGrantId && active.grant_id == callerGrantId) replaceable = true;
  }
  return rtcAdmission(wsCount, wsGrantCount, rtc.active.size(), rtcGrantCount, callerGrantId, replaceable);
}

void Server::abortPendingRtc(bool evictClient, uint16_t code, const char* reason) {
  if (rtc.offer.session) rtc.offer.session->close();
  lws* client = rtc.offer.client;
  rtc.offer = {};
  if (evictClient && client) evict(client, code, reason);
}

void Server::closeActiveRtc(size_t index) {
  auto active = std::move(rtc.active[index]);
  rtc.active.erase(rtc.active.begin() + index);
  if (active.subscriber_id) hub.detach(active.subscriber_id);
  if (active.owns_input) {
    release();
    if (input) input->cancel();
  }
  if (active.grant_id) {
    if (active.session && active.session->everConnected()) grants.commit(active.grant_id);
    else grants.release(active.grant_id);
  }
  if (active.session) active.session->close();
}

void Server::assignRtcInput() {
  if (holdsInput()) return;
  const auto now = Grants::Clock::now();
  for (int pass = 0; pass < 2; ++pass) {
    for (auto it = rtc.active.rbegin(); it != rtc.active.rend(); ++it) {
      if (!it->can_input || it->session->closed() || (it->grant_id && !grants.active(it->grant_id, now))) continue;
      if ((it->grant_id != 0) != (pass == 1)) continue;
      it->owns_input = true;
      if (input) input->resetLocks();
      return;
    }
  }
}
#endif

int Server::startStream(lws* wsi, Socket socket, const ConnectionPlan& plan, bool clipboardNotices) {
  if (plan.closeStream) {
    if (input_viewer) {
      auto* previous = input_viewer;
      evict(previous);
      endStream(previous, false);
    }
#ifdef RELAY_RTC
    else {
      for (size_t i = 0; i < rtc.active.size(); ++i) {
        if (rtc.active[i].owns_input) { closeActiveRtc(i); break; }
      }
    }
#endif
  }
  if (plan.closeControl) { evict(control); endControl(false); }
  ViewerSlot* target = nullptr;
  for (auto& slot : viewers) if (!slot.viewer) { target = &slot; break; }
  if (!target) {
#ifdef RELAY_RTC
    assignRtcInput();
#endif
    return -1;
  }
  const SubscriberRole role = socket == Socket::watch ? SubscriberRole::watch : SubscriberRole::controller;
  auto sub = hub.attach(role, ++nextGeneration, clipboardNotices);
  if (!sub) {
#ifdef RELAY_RTC
    assignRtcInput();
#endif
    return -1;
  }
#ifdef __linux__
  configureStreamSocket(wsi);
#endif
  if (socket != Socket::watch) { input_viewer = wsi; input->resetLocks(); }
  target->viewer = wsi;
  target->sub = std::move(sub);
  target->width = width;
  target->height = height;
  updateSlotFlow(*target);
  return 0;
}

void Server::release() { if (input) input->releaseAll(); }

void Server::endStream(lws* wsi, bool handoff) {
  auto* slot = slotFor(wsi);
  if (!slot) return;
  if (input_viewer == wsi) { release(); input->cancel(); input_viewer = nullptr; }
  if (slot->sub) {
    hub.detach(slot->sub->id);
    slot->sub.reset();
  }
  slot->viewer = nullptr;
  slot->width = slot->height = 0;
#ifdef RELAY_RTC
  if (handoff) assignRtcInput();
#else
  (void)handoff;
#endif
}

void Server::endControl(bool handoff) {
  if (control) { release(); input->cancel(); }
  control_received.clear(); replies.clear(); control_ready = false; control_generation = 0; control = nullptr;
#ifdef RELAY_RTC
  if (handoff) assignRtcInput();
#else
  (void)handoff;
#endif
}

void Server::endRtc() {
#ifdef RELAY_RTC
  abortPendingRtc(false);
  while (!rtc.active.empty()) closeActiveRtc(rtc.active.size() - 1);
#endif
}

void Server::end() {
  endRtc();
  endControl();
  for (auto& slot : viewers) if (slot.viewer) endStream(slot.viewer);
}

void Server::expireGrants() {
  const auto now = Grants::Clock::now();
  auto expired = [&](lws* wsi) {
    auto* response = static_cast<HttpResponse*>(lws_wsi_user(wsi));
    return response && response->grant_id && !grants.active(response->grant_id, now);
  };
  if (control && expired(control)) { evict(control, LWS_CLOSE_STATUS_POLICY_VIOLATION, "grant ended"); endControl(); }
  for (auto& slot : viewers) if (slot.viewer && expired(slot.viewer)) {
    evict(slot.viewer, LWS_CLOSE_STATUS_POLICY_VIOLATION, "grant ended");
    endStream(slot.viewer);
  }
#ifdef RELAY_RTC
  if (rtc.hasOffer() && rtc.offer.grant_id && !grants.active(rtc.offer.grant_id, now)) {
    abortPendingRtc(true, LWS_CLOSE_STATUS_POLICY_VIOLATION, "grant ended");
  }
  for (size_t i = rtc.active.size(); i > 0; --i) {
    if (rtc.active[i - 1].grant_id && !grants.active(rtc.active[i - 1].grant_id, now)) closeActiveRtc(i - 1);
  }
  const uint64_t now_us = nowUs();
  for (const auto& active : rtc.active) {
    unsigned window = 1;
    uint64_t deadline = 0;
    uint32_t lowat = 0;
    hub.updateFlow(active.sub, now_us, std::nullopt, window, deadline, lowat);
  }
  assignRtcInput();
#endif
}
void Server::evict(lws* wsi, uint16_t code, const char* reason) {
  auto* bytes = reinterpret_cast<unsigned char*>(const_cast<char*>(reason));
  lws_close_reason(wsi, static_cast<lws_close_status>(code), bytes, std::strlen(reason));
  closing.insert(wsi);
  lws_set_timer_usecs(wsi, 1);
}
namespace {
/// The 20-byte NSL1 envelope of a received message, or false when it is malformed.
bool envelope(const std::vector<uint8_t>& b, uint32_t& gen, uint32_t& seq) {
  if (b.size() < 20 || std::memcmp(b.data(), "NSL1", 4) || b[4] != 1 || u16(b.data()+6) || u32(b.data()+16) != b.size()-20) return false;
  gen = u32(b.data()+8); seq = u32(b.data()+12);
  return gen != 0;
}
}  // namespace
bool Server::controlMessage() {
  const auto& b = control_received;
  uint32_t gen = 0, seq = 0;
  if (!envelope(b, gen, seq) || b[5] != 3 || b.size() != 36 || !seq || gen != control_generation || replies.size() >= 32) return false;
  auto reply = std::make_shared<ControlReply>();
  reply->seq = seq; reply->status = input->apply(inputEvent(b.data()+20));
  replies.push_back(reply);
  input->fence(std::make_shared<ReplyFence>(wake, [reply](bool, size_t) { reply->ready.store(true, std::memory_order_release); }));
  lws_callback_on_writable(control); return true;
}
bool Server::streamMessage(ViewerSlot& slot) {
  if (!slot.sub) return false;
  const auto& b = slot.sub->received;
  uint32_t gen = 0, seq = 0;
  if (!envelope(b, gen, seq)) return false;
  if (b[5] == 2) {
    if (b.size() != 20 && b.size() != 24) return false;
    const uint64_t wait = FlowControl::ackWaitUs(b.data() + 20, b.size() - 20);
    if (hub.acknowledge(slot.sub, gen, seq, nowUs(), wait)) updateSlotFlow(slot);
    return true;
  }
  if (b[5] != 3 || b.size() != 36 || seq || gen != slot.sub->generation) return false;
  if (input_viewer != slot.viewer) return true;
  return input->apply(inputEvent(b.data() + 20)) != InputStatus::invalid;
}

void Server::updateSlotFlow(ViewerSlot& slot) {
  if (!slot.viewer || !slot.sub) return;
  if (!lws_partial_buffered(slot.viewer)) slot.sub->buffered_bytes = 0;
  std::optional<FlowControl::TransportSample> sample;
#ifdef __linux__
  if (!config.proxy) sample = streamTransportSample(slot.viewer, slot.sub->buffered_bytes);
#endif
  unsigned window = 1;
  uint64_t deadline = 0;
  uint32_t lowat = 0;
  hub.updateFlow(slot.sub, nowUs(), sample, window, deadline, lowat);
  (void)window;
#ifdef __linux__
  if (lowat != slot.sub->notsent_lowat) {
    const int fd = lws_get_socket_fd(slot.viewer);
    if (fd >= 0) (void)setsockopt(fd, IPPROTO_TCP, TCP_NOTSENT_LOWAT, &lowat, sizeof(lowat));
    slot.sub->notsent_lowat = lowat;
  }
#endif
  if (deadline != slot.sub->flow_timer_due_us) {
    const uint64_t now = nowUs();
    lws_set_timer_usecs(slot.viewer, deadline - std::min(deadline, now));
    slot.sub->flow_timer_due_us = deadline;
  }
}

std::string Server::metrics() {
  return hub.primaryMetrics(nowUs());
}

std::string Server::rtcConfigJson() const {
#ifndef RELAY_RTC
  return "{\"enabled\":false,\"iceServers\":[]}";
#else
  std::string json = "{\"enabled\":true,\"iceServers\":[";
  for (size_t i = 0; i < config.ice_servers.size(); ++i) {
    if (i) json += ',';
    const auto& ice = config.ice_servers[i];
    json += "{\"urls\":" + jsonString(ice.url);
    if (!ice.username.empty()) {
      json += ",\"username\":" + jsonString(ice.username);
      json += ",\"credential\":" + jsonString(ice.credential);
    }
    json += '}';
  }
  json += "]}";
  return json;
#endif
}
int Server::writeControl(lws* wsi) {
  if (!control_ready && (replies.empty() || !replies.front()->ready.load(std::memory_order_acquire))) return 0;
  std::vector<uint8_t> wire;
  if (control_ready) controlReady(wire, LWS_PRE, control_generation, width, height);
  else inputReply(wire, LWS_PRE, control_generation, replies.front()->seq, replies.front()->status);
  const size_t size = wire.size() - LWS_PRE;
  if (lws_write(wsi, wire.data() + LWS_PRE, size, LWS_WRITE_BINARY) != int(size)) return -1;
  if (control_ready) control_ready = false; else replies.pop_front();
  if (!replies.empty() && replies.front()->ready.load(std::memory_order_acquire)) lws_callback_on_writable(wsi);
  return 0;
}
void Server::InputWake::set(lws_context* next) {
  std::lock_guard<std::mutex> lock(mutex);
  context = next;
}
void Server::InputWake::cancel() {
  std::lock_guard<std::mutex> lock(mutex);
  if (context) lws_cancel_service(context);
}
int Server::deferInput(lws* wsi, InputStatus status, size_t applied, size_t posted) {
  auto reply = std::make_shared<InputReply>();
  reply->wsi = wsi;
  if (status == InputStatus::ok) {
    reply->status = HTTP_STATUS_OK;
    reply->body = "{\"applied\":" + std::to_string(applied) + "}";
  } else {
    const bool invalid = status == InputStatus::invalid;
    reply->status = invalid ? HTTP_STATUS_BAD_REQUEST : 422;
    reply->body = std::string("{\"error\":\"") + (invalid ? "invalid_input" : "unsupported_input") +
                  "\",\"index\":" + std::to_string(applied - 1) + "}";
  }
  { std::lock_guard<std::mutex> lock(reply_mutex); input_replies.push_back(reply); }
  input->fence(std::make_shared<ReplyFence>(wake, [reply, posted](bool complete, size_t dropped) {
    if (!complete) {
      reply->status = HTTP_STATUS_CONFLICT;
      reply->body = "{\"error\":\"busy\",\"applied\":" + std::to_string(posted - dropped) + "}";
    }
    reply->ready.store(true, std::memory_order_release);
  }));
  return 0;
}
std::vector<std::shared_ptr<Server::InputReply>> Server::readyInputs() {
  std::vector<std::shared_ptr<InputReply>> ready;
  std::lock_guard<std::mutex> lock(reply_mutex);
  for (auto reply = input_replies.begin(); reply != input_replies.end();) {
    if (!(*reply)->ready.load(std::memory_order_acquire)) { ++reply; continue; }
    ready.push_back(*reply); reply = input_replies.erase(reply);
  }
  return ready;
}
void Server::forgetInput(lws* wsi) {
  std::lock_guard<std::mutex> lock(reply_mutex);
  input_replies.erase(std::remove_if(input_replies.begin(), input_replies.end(),
      [wsi](const std::shared_ptr<InputReply>& reply) { return reply->wsi == wsi; }), input_replies.end());
}
int Server::writeSlot(ViewerSlot& slot) {
  auto* wsi = slot.viewer;
  if (!wsi || !slot.sub) return -1;
  updateSlotFlow(slot);
  std::vector<uint8_t> wire;
  if (slot.sub->last_sent_sequence && slot.sub->clipboard_pending) {
    clipboardNotice(wire, LWS_PRE, slot.sub->generation);
    const size_t size = wire.size() - LWS_PRE;
    if (lws_write(wsi, wire.data() + LWS_PRE, size, LWS_WRITE_BINARY) != int(size)) return -1;
    slot.sub->clipboard_pending = false;
    lws_callback_on_writable(wsi);
    return 0;
  }
  std::optional<ViewerPacket> packet;
  std::optional<CursorImage> cursor;
  bool failed = false, more_pending = false;
  if (!hub.popOutbound(slot.sub, packet, cursor, failed, more_pending)) {
    return failed ? -1 : 0;
  }
  if (cursor) {
    if (!cursorMessage(wire, LWS_PRE, slot.sub->generation, *cursor)) return -1;
    const size_t size = wire.size() - LWS_PRE;
    if (lws_write(wsi, wire.data() + LWS_PRE, size, LWS_WRITE_BINARY) != int(size)) return -1;
    slot.sub->buffered_bytes = lws_partial_buffered(wsi) ? size : 0;
    updateSlotFlow(slot);
    if (more_pending || slot.sub->clipboard_pending) lws_callback_on_writable(wsi);
    return 0;
  }
  const auto& f = *packet->frame;
  if (!frameMessage(wire, LWS_PRE, slot.sub->generation, slot.sub->last_sent_sequence,
                    packet->sequence, f, slot.width, slot.height)) return -1;
  const size_t size = wire.size() - LWS_PRE;
  if (lws_write(wsi, wire.data() + LWS_PRE, size, LWS_WRITE_BINARY) != int(size)) return -1;
  slot.sub->buffered_bytes = lws_partial_buffered(wsi) ? size : 0;
  slot.width = f.width;
  slot.height = f.height;
  slot.sub->last_sent_sequence = packet->sequence;
  if (!hub.markSent(slot.sub, packet->sequence, nowUs())) return -1;
  updateSlotFlow(slot);
  if (more_pending || slot.sub->clipboard_pending) lws_callback_on_writable(wsi);
  return 0;
}
namespace {
std::string httpBearer(lws* wsi) {
  const auto auth = header(wsi, WSI_TOKEN_HTTP_AUTHORIZATION);
  return auth.rfind("Bearer ", 0) == 0 ? auth.substr(7) : std::string{};
}
int responseHeaders(lws* wsi, unsigned status, const char* mime, size_t length, uint64_t rtcSessionId = 0) {
  unsigned char buffer[LWS_PRE+512];
  unsigned char* start = buffer+LWS_PRE;
  unsigned char* next = start;
  unsigned char* end = buffer+sizeof(buffer);
  const std::string location = rtcSessionId ? "/rtc/sessions/" + std::to_string(rtcSessionId) : std::string{};
  if (lws_add_http_common_headers(wsi, status, mime, length, &next, end) ||
      (!location.empty() && lws_add_http_header_by_name(wsi, reinterpret_cast<const unsigned char*>("location:"),
                                          reinterpret_cast<const unsigned char*>(location.data()), location.size(), &next, end)) ||
      lws_add_http_header_by_name(wsi, reinterpret_cast<const unsigned char*>("cache-control:"),
                                  reinterpret_cast<const unsigned char*>("no-store"), 8, &next, end) ||
      lws_add_http_header_by_token(wsi, WSI_TOKEN_CONNECTION,
                                   reinterpret_cast<const unsigned char*>("close"), 5, &next, end) ||
      lws_finalize_http_header(wsi, &next, end) ||
      lws_write(wsi, start, size_t(next-start), LWS_WRITE_HTTP_HEADERS) != next-start) return -1;
  lws_callback_on_writable(wsi); return 0;
}
/// Closes the HTTP connection once its response is flushed, since libwebsockets 4.1 spins on an idle
/// keep-alive connection that the peer has half-closed.
int completeResponse(lws* wsi, HttpResponse* response) {
  if (!lws_partial_buffered(wsi)) return -1;
  if (response) response->closing = true;
  lws_callback_on_writable(wsi); return 0;
}
int jsonResponse(lws* wsi, HttpResponse* response, unsigned status, const std::string& json) {
  if (!response) return -1;
  if (json.size() > sizeof(response->body)) {
    delete response->image;
    response->image = new std::vector<uint8_t>(json.begin(), json.end());
    response->image_status = status;
    response->image_type = "application/json";
    response->image_headers = false;
    response->offset = 0;
    lws_callback_on_writable(wsi);
    return 0;
  }
  std::memcpy(response->body, json.data(), json.size()); response->length = json.size();
  return responseHeaders(wsi, status, "application/json", response->length);
}
int errorResponse(lws* wsi, HttpResponse* response, unsigned status, const char* error) {
  return jsonResponse(wsi, response, status, "{\"error\":\"" + std::string(error) + "\"}");
}
constexpr char fileCloseHeaders[] = "connection: close\r\n";
constexpr char viewerHtmlHeaders[] =
    "connection: close\r\n"
    "content-security-policy: frame-ancestors 'none'\r\n"
    "x-frame-options: DENY\r\n";
void closeScreenshot(Server* server, lws* wsi, HttpResponse* response) {
  if (server->screenshot_client == wsi) {
    server->screenshot_client = nullptr;
    lws_set_timer_usecs(wsi, LWS_SET_TIMER_USEC_CANCEL);
    // During capture the slot stays busy until its worker result is safely discarded.
    if (response && response->image) server->screenshot.finish();
  }
  if (response) { delete response->image; response->image = nullptr; response->offset = 0; }
}
int inputResponse(lws* wsi, HttpResponse* response, Server* s) {
  const bool complete = response->input_length == response->input_expected;
  response->input_expected = 0;
  if (!complete) return -1;
  if (s->holdsInput()) return errorResponse(wsi, response, HTTP_STATUS_CONFLICT, "busy");
  const size_t count = response->input_length / 16;
  if (s->input->pending() + count > max_queued_events) return errorResponse(wsi, response, HTTP_STATUS_CONFLICT, "busy");
  size_t index = 0;
  auto status = InputStatus::ok;
  for (; index < count && status == InputStatus::ok; ++index) status = s->input->apply(inputEvent(response->input + index * 16));
  s->release();
  return s->deferInput(wsi, status, index, status == InputStatus::ok ? index : index - 1);
}
/// Queues the uploaded text as a clipboard write once the whole body arrived; the reply follows the write.
int clipboardWrite(lws* wsi, HttpResponse* response, Server* s) {
  std::string text = std::move(*response->upload);
  const bool complete = text.size() == response->upload_expected;
  delete response->upload; response->upload = nullptr;
  if (!complete) return -1;
  if (!validText(text)) return errorResponse(wsi, response, HTTP_STATUS_BAD_REQUEST, "invalid_text");
  if (!s->clipboard.submit(wsi, std::move(text))) return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "clipboard_busy");
  return 0;
}
#ifdef RELAY_RTC
/** Starts asynchronous ICE gathering for a WebRTC offer without blocking the lws service loop. */
int rtcOfferStart(lws* wsi, HttpResponse* response, Server* s) {
  std::string offer = std::move(*response->upload);
  const bool complete = offer.size() == response->upload_expected;
  delete response->upload; response->upload = nullptr; response->rtc_offer = false;
  if (!complete) {
    if (s->rtc.offer.client == wsi) s->abortPendingRtc(false);
    return -1;
  }
  if (s->rtc.offer.stage != Server::RtcOfferStage::receiving_body || s->rtc.offer.client != wsi) {
    return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "rtc_busy");
  }
  if (response->grant_id && !s->grants.active(response->grant_id, Grants::Clock::now())) {
    s->abortPendingRtc(false);
    return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
  }
  const RtcAdmission admission = s->planRtcAdmission(response->grant_id);
  if (!admission.allowed) {
    s->abortPendingRtc(false);
    return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "viewer_limit");
  }
  const bool can_input = response->socket != Socket::watch;
  RtcCallbacks cb;
  cb.wake = [wake = s->wake] { wake->cancel(); };
  cb.request_keyframe = [s] { s->hub.requestKeyframe(); };
  cb.profile_level_id = [s] { return s->hub.profileLevelId(); };
  auto session = std::make_shared<RtcSession>(s->config.ice_servers, can_input, response->grant_id == 0, std::move(cb));
  s->rtc.offer.session = session;
  s->rtc.offer.stage = Server::RtcOfferStage::gathering;
  s->rtc.offer.can_input = can_input;
  s->rtc.offer.grant_id = response->grant_id;
  session->startOffer(std::move(offer));
  lws_set_timer_usecs(wsi, 5000000);
  return 0;
}
#endif
int metricsResponse(lws* wsi, HttpResponse* response, Server* server) {
  if (!response) return -1;
  std::string json;
  const bool available = cgroupMetrics(json);
  if (!available) json = "{\"resources_available\":false,\"usage_usec\":null,\"memory_current\":null,\"inactive_file\":null}";
  json.pop_back(); json += server->metrics() + "}";
  if (json.size() > sizeof(response->body)) return -1;
  std::memcpy(response->body, json.data(), json.size());
  response->length = json.size();
  return responseHeaders(wsi, HTTP_STATUS_OK,
                         "application/json", response->length);
}
}  // namespace
int callback(lws* wsi, lws_callback_reasons reason, void* user, void* in, size_t len) {
  auto* s = static_cast<Server*>(lws_context_user(lws_get_context(wsi)));
  if (!s) return 0;
  switch (reason) {
    case LWS_CALLBACK_HTTP: {
      const std::string path(static_cast<const char*>(in), len);
      auto* response = static_cast<HttpResponse*>(user);
      if (response) { response->input_reply = false; response->input_headers = false; response->reply_status = 0; response->rtc_offer = false; response->rtc_session_id = 0; }
      if (path == "/input") {
        if (!response) return -1;
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (!authenticated(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        uint64_t length = 0;
        if (const auto status = inputLength(header(wsi, WSI_TOKEN_HTTP_CONTENT_LENGTH), length)) {
          return errorResponse(wsi, response, status, status == HTTP_STATUS_LENGTH_REQUIRED ? "length_required" :
                               status == HTTP_STATUS_REQ_ENTITY_TOO_LARGE ? "too_large" : "invalid_input");
        }
        if (s->holdsInput()) return errorResponse(wsi, response, HTTP_STATUS_CONFLICT, "busy");
        response->input_length = 0; response->input_expected = length; return 0;
      }
      if (path == "/rtc/config") {
        if (!response) return -1;
        if (lws_hdr_total_length(wsi, WSI_TOKEN_GET_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (!authenticated(s->config, wsi) && !s->grants.available(httpBearer(wsi), Grants::Clock::now())) {
          return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        }
        return jsonResponse(wsi, response, HTTP_STATUS_OK, s->rtcConfigJson());
      }
#ifdef RELAY_RTC
      if (path == "/rtc") {
        if (!response) return -1;
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        response->grant_id = 0;
        Socket requested_socket = Socket::stream;
        const bool caller_is_owner = authenticated(s->config, wsi);
        if (!caller_is_owner) {
          const auto* grant = s->grants.available(httpBearer(wsi), Grants::Clock::now());
          if (!grant) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
          response->grant_id = grant->id;
          if (grant->scope == GrantScope::watch) requested_socket = Socket::watch;
        }
        if (lws_hdr_fragment_length(wsi, WSI_TOKEN_HTTP_URI_ARGS, 0) > 0) {
          char arg[8] = {};
          const int length = lws_hdr_copy_fragment(wsi, arg, sizeof(arg), WSI_TOKEN_HTTP_URI_ARGS, 0);
          if (length < 0 || std::string(arg, size_t(length)) != "view=1" ||
              lws_hdr_fragment_length(wsi, WSI_TOKEN_HTTP_URI_ARGS, 1) > 0) {
            return errorResponse(wsi, response, HTTP_STATUS_BAD_REQUEST, "invalid_query");
          }
          requested_socket = Socket::watch;
        }
        if (s->rtc.hasOffer()) {
          return errorResponse(wsi, response, HTTP_STATUS_CONFLICT, "busy");
        }
        const RtcAdmission admission = s->planRtcAdmission(response->grant_id);
        if (!admission.allowed) {
          return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "viewer_limit");
        }
        uint64_t length = 0;
        if (!unsignedNumber(header(wsi, WSI_TOKEN_HTTP_CONTENT_LENGTH), length) || !length || length > 65536) {
          return errorResponse(wsi, response, HTTP_STATUS_BAD_REQUEST, "invalid_offer");
        }
        s->rtc.offer.stage = Server::RtcOfferStage::receiving_body;
        s->rtc.offer.client = wsi;
        s->rtc.offer.grant_id = response->grant_id;
        s->rtc.offer.can_input = false;
        lws_set_timer_usecs(wsi, 5000000);
        response->socket = requested_socket;
        response->upload = new std::string();
        response->upload->reserve(size_t(length));
        response->upload_expected = length;
        response->rtc_offer = true;
        return 0;
      }
      if (path == "/rtc/session" || path.rfind("/rtc/sessions/", 0) == 0) {
        if (!response) return -1;
        if (lws_hdr_total_length(wsi, WSI_TOKEN_DELETE_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        const bool caller_is_owner = authenticated(s->config, wsi);
        uint64_t caller_grant_id = 0;
        if (!caller_is_owner) {
          const auto* grant = s->grants.find(httpBearer(wsi), Grants::Clock::now());
          if (!grant) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
          caller_grant_id = grant->id;
        }
        uint64_t session_id = 0;
        if (path != "/rtc/session" && (!unsignedNumber(path.substr(14), session_id) || !session_id)) {
          return errorResponse(wsi, response, HTTP_STATUS_NOT_FOUND, "not_found");
        }
        size_t index = s->rtc.active.size();
        for (size_t i = s->rtc.active.size(); i > 0; --i) {
          const auto& active = s->rtc.active[i - 1];
          if (session_id ? active.session_id == session_id : active.grant_id == caller_grant_id) {
            index = i - 1;
            break;
          }
        }
        if (index == s->rtc.active.size()) return errorResponse(wsi, response, HTTP_STATUS_NOT_FOUND, "not_found");
        if (!rtcSessionAuthorized(caller_is_owner, caller_grant_id, s->rtc.active[index].grant_id)) {
          return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        }
        s->closeActiveRtc(index);
        s->assignRtcInput();
        return jsonResponse(wsi, response, HTTP_STATUS_OK, "{\"ended\":true}");
      }
#endif
      if (path == "/clipboard") {
        if (!response) return -1;
        const bool write = lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) > 0;
        if (!write && lws_hdr_total_length(wsi, WSI_TOKEN_GET_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (!authenticated(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        if (!s->clipboard.available()) return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "clipboard_unavailable");
        if (!write) {
          if (!s->clipboard.submit(wsi, std::nullopt)) return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "clipboard_busy");
          return 0;
        }
        uint64_t length = 0;
        if (const auto status = clipboardLength(header(wsi, WSI_TOKEN_HTTP_CONTENT_LENGTH), length)) {
          return errorResponse(wsi, response, status, status == HTTP_STATUS_LENGTH_REQUIRED ? "length_required" :
                               status == HTTP_STATUS_REQ_ENTITY_TOO_LARGE ? "too_large" : "invalid_text");
        }
        response->upload = new std::string();
        response->upload->reserve(size_t(length));
        response->upload_expected = length;
        return length ? 0 : clipboardWrite(wsi, response, s);
      }
      if (path.rfind("/grants/", 0) == 0) {
        if (!response) return -1;
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (s->config.token.empty() || !authenticated(s->config, wsi)) {
          return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        }
        const auto name = path.substr(8);
        if (name == "watch" || name == "control") {
          if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) <= 0) {
            return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
          }
          // Query: ttl=SECONDS (1 to 3600) and connections=1 (a single-connection grant), each at most once.
          uint64_t ttl = Grants::max_ttl;
          bool single = false, ttl_seen = false, connections_seen = false;
          char arg[64] = {};
          for (int index = 0; lws_hdr_fragment_length(wsi, WSI_TOKEN_HTTP_URI_ARGS, index) > 0; ++index) {
            // A fragment that does not fit is invalid, not the end of the query.
            const int length = lws_hdr_copy_fragment(wsi, arg, sizeof(arg), WSI_TOKEN_HTTP_URI_ARGS, index);
            if (length < 0) return errorResponse(wsi, response, HTTP_STATUS_BAD_REQUEST, "invalid_query");
            const std::string pair(arg, size_t(length));
            if (pair.rfind("connections=", 0) == 0) {
              if (connections_seen || pair != "connections=1") {
                return errorResponse(wsi, response, HTTP_STATUS_BAD_REQUEST, "invalid_connections");
              }
              connections_seen = single = true;
            } else if (pair.rfind("ttl=", 0) != 0 || ttl_seen || !unsignedNumber(pair.substr(4), ttl) || !ttl || ttl > Grants::max_ttl) {
              return errorResponse(wsi, response, HTTP_STATUS_BAD_REQUEST, "invalid_ttl");
            } else {
              ttl_seen = true;
            }
          }
          unsigned char bytes[32];
          if (!secureRandom(bytes, sizeof(bytes))) return errorResponse(wsi, response, HTTP_STATUS_INTERNAL_SERVER_ERROR, "random_failed");
          static const char digits[] = "0123456789abcdef";
          std::string token;
          for (const unsigned char byte : bytes) { token += digits[byte >> 4]; token += digits[byte & 15]; }
          const auto scope = name == "watch" ? GrantScope::watch : GrantScope::control;
          const auto id = s->grants.issue(token, scope, Grants::Clock::now(), ttl, single);
          if (!id) return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "grant_limit");
          return jsonResponse(wsi, response, HTTP_STATUS_OK, "{\"id\":\"" + std::to_string(id) + "\",\"token\":\"" + token +
            "\",\"expires_in\":" + std::to_string(ttl) + ",\"scope\":\"" + name + "\"" +
            (single ? ",\"connections\":1}" : "}"));
        }
        uint64_t id = 0;
        if (!unsignedNumber(name, id) || !id) return errorResponse(wsi, response, HTTP_STATUS_NOT_FOUND, "not_found");
        if (lws_hdr_total_length(wsi, WSI_TOKEN_DELETE_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!s->grants.revoke(id)) return errorResponse(wsi, response, HTTP_STATUS_NOT_FOUND, "not_found");
        s->expireGrants();
        return jsonResponse(wsi, response, HTTP_STATUS_OK, "{\"revoked\":true}");
      }
      if (path == "/metrics" || path == "/capabilities" || path == "/screenshot.png") {
        if (lws_hdr_total_length(wsi, WSI_TOKEN_GET_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (!authenticated(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        if (path == "/metrics") return metricsResponse(wsi, response, s);
        if (path == "/screenshot.png") {
          if (s->screenshot_client || !s->screenshot.request()) {
            return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "busy");
          }
          s->screenshot_client = wsi; response->image_headers = false; response->offset = 0;
          lws_set_timer_usecs(wsi, 5000000); return 0;
        }
        const std::string backend = s->input->name();
        const auto stats = s->hub.stats();
        const bool rtc_enabled =
#ifdef RELAY_RTC
            true;
#else
            false;
#endif
        const std::string json = "{\"version\":1,\"backend\":\"" + backend +
            "\",\"width\":" + std::to_string(s->width) + ",\"height\":" + std::to_string(s->height) +
            ",\"fps\":" + std::to_string(s->config.fps) +
            ",\"input\":{\"keyboard\":true,\"pointer\":true,\"buttons\":true,\"wheel\":true}," +
            "\"screenshot\":\"/screenshot.png\",\"control\":\"/control\",\"wayland\":" +
            (backend == "wayland" ? "true" : "false") +
            ",\"max_input_pending\":32,\"cursor\":" + (stats.cursor_supported ? "true" : "false") +
            ",\"encoder\":" + jsonString(stats.encoder) +
            ",\"hardware_encoder\":" + (stats.hardware_encoder ? "true" : "false") +
            ",\"encoder_state\":" + jsonString(stats.encoder_state) +
            ",\"transfer_tier\":" + jsonString(transferTierName(stats.transfer_tier)) +
            ",\"rtc\":" + (rtc_enabled ? "true" : "false") +
            ",\"ice_servers\":" + std::to_string(s->config.ice_servers.size()) +
            ",\"input_endpoint\":\"/input\",\"max_input_batch\":" + std::to_string(max_input_batch) +
            ",\"audio\":false,\"clipboard\":" + (s->clipboard.available() ? "true" : "false") +
            ",\"clipboard_endpoint\":\"/clipboard\",\"max_clipboard_bytes\":" + std::to_string(max_clipboard_bytes) +
            ",\"resize\":false,\"ime\":false}";
        return jsonResponse(wsi, response, HTTP_STATUS_OK, json);
      }
      std::string file; const char* mime = nullptr; const char* headers = nullptr; int headerCount = 0;
      if (path == "/" || path == "/index.html") {
        file=s->config.viewer+"/index.html"; mime="text/html";
        headers=viewerHtmlHeaders; headerCount=int(sizeof(viewerHtmlHeaders)-1);
      }
      if (path == "/viewer.js") {
        file=s->config.viewer+"/viewer.js"; mime="application/javascript";
        headers=fileCloseHeaders; headerCount=int(sizeof(fileCloseHeaders)-1);
      }
      if (file.empty()) return errorResponse(wsi, response, HTTP_STATUS_NOT_FOUND, "not_found");
      return lws_serve_http_file(wsi, file.c_str(), mime, headers, headerCount) < 0 ? -1 : 0;
    }
    case LWS_CALLBACK_HTTP_WRITEABLE: {
      auto* response = static_cast<HttpResponse*>(user);
      if (!response) return -1;
      if (response->closing) return completeResponse(wsi, response);
      if (response->input_reply) {
        if (!response->input_headers) {
          response->input_headers = true;
          return responseHeaders(wsi, response->reply_status, "application/json", response->length);
        }
        response->input_reply = false;
      }
      if (response->image) {
        if (!response->image_headers) {
          response->image_headers = true;
          return responseHeaders(wsi, response->image_status, response->image_type, response->image->size(), response->rtc_session_id);
        }
        unsigned char chunk[LWS_PRE + 16384];
        const size_t count = std::min<size_t>(16384, response->image->size() - response->offset);
        const bool final = response->offset + count == response->image->size();
        std::memcpy(chunk+LWS_PRE, response->image->data()+response->offset, count);
        if (lws_write(wsi, chunk+LWS_PRE, count, final ? LWS_WRITE_HTTP_FINAL : LWS_WRITE_HTTP) != int(count)) return -1;
        response->offset += count;
        if (!final) { lws_callback_on_writable(wsi); return 0; }
        closeScreenshot(s, wsi, response); return completeResponse(wsi, response);
      }
      if (!response->length) return 0;
      unsigned char buffer[LWS_PRE + sizeof(response->body)];
      std::memcpy(buffer + LWS_PRE, response->body, response->length);
      const size_t count = response->length;
      response->length = 0;
      if (lws_write(wsi, buffer + LWS_PRE, count, LWS_WRITE_HTTP_FINAL) != int(count)) return -1;
      return completeResponse(wsi, response);
    }
    case LWS_CALLBACK_HTTP_BODY: {
      auto* response = static_cast<HttpResponse*>(user);
      if (response && response->upload) {
        if (len > response->upload_expected - response->upload->size()) return -1;
        response->upload->append(static_cast<const char*>(in), len);
        return 0;
      }
      if (!response || !response->input_expected) return 0;
      if (len > response->input_expected - response->input_length) return -1;
      std::memcpy(response->input + response->input_length, in, len); response->input_length += len;
      return 0;
    }
    case LWS_CALLBACK_HTTP_BODY_COMPLETION: {
      auto* response = static_cast<HttpResponse*>(user);
#ifdef RELAY_RTC
      if (response && response->upload && response->rtc_offer) return rtcOfferStart(wsi, response, s);
#endif
      if (response && response->upload) return clipboardWrite(wsi, response, s);
      return response && response->input_expected ? inputResponse(wsi, response, s) : 0;
    }
    case LWS_CALLBACK_CLOSED_HTTP: {
      auto* response = static_cast<HttpResponse*>(user);
      closeScreenshot(s, wsi, response); s->forgetInput(wsi); s->clipboard.forget(wsi);
#ifdef RELAY_RTC
      if (s->rtc.offer.client == wsi) s->abortPendingRtc(false);
#endif
      if (response) { delete response->upload; response->upload = nullptr; }
      return 0;
    }
    case LWS_CALLBACK_HTTP_FILE_COMPLETION: return completeResponse(wsi, static_cast<HttpResponse*>(user));
    case LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION: {
      char uri[256] = {}, arg[256] = {};
      if (lws_hdr_copy(wsi, uri, sizeof(uri), WSI_TOKEN_GET_URI) <= 0 || !user) return 1;
      std::string target(uri);
      for (int index = 0; lws_hdr_copy_fragment(wsi, arg, sizeof(arg), WSI_TOKEN_HTTP_URI_ARGS, index) > 0; ++index) {
        target += index ? '&' : '?';
        target += arg;
      }
      const Target parsed = viewerTarget(target);
      if (parsed.socket == Socket::none || !localHost(s->config, wsi) || s->nextGeneration == UINT32_MAX) return 1;
      auto* response = static_cast<HttpResponse*>(user);
      response->grant_id = 0;
      // The session token keeps the browser Origin check. A grant is already a
      // scoped, revocable credential, and MCP App hosts frame viewers on opaque
      // or per-load origins, so a grant connects from any origin, null included.
      if (authenticated(s->config, wsi, true)) {
        if (!allowedOrigin(s->config, wsi)) return 1;
      } else {
        const auto* grant = s->grants.available(websocketBearer(wsi), Grants::Clock::now());
        if (!grant || parsed.clipboard || (grant->scope == GrantScope::watch && parsed.socket != Socket::watch)) return 1;
        response->grant_id = grant->id;
      }
      if (!s->planConnection(parsed.socket, response->grant_id != 0).open && parsed.socket != Socket::control) return 1;
      response->socket = parsed.socket; response->clipboard = parsed.clipboard;
      return 0;
    }
    case LWS_CALLBACK_ESTABLISHED: {
      if (s->nextGeneration == UINT32_MAX) return -1;
      const auto* response = static_cast<HttpResponse*>(user);
      if (response->grant_id && !s->grants.active(response->grant_id, Grants::Clock::now())) {
        s->evict(wsi, LWS_CLOSE_STATUS_POLICY_VIOLATION, "grant ended");
        return 0;
      }
      const Socket socket = response->socket;
      const auto plan = s->planConnection(socket, response->grant_id != 0);
      if (!plan.open) {
        if (socket == Socket::control) { s->evict(wsi, close_busy, "busy"); return 0; }
        return -1;
      }
      // Claimed only now, so a connection refused for another reason doesn't
      // use up a single-connection grant.
      if (response->grant_id && !s->grants.claim(response->grant_id)) {
        s->evict(wsi, LWS_CLOSE_STATUS_POLICY_VIOLATION, "grant used");
        return 0;
      }
      if (socket == Socket::control) {
        s->control = wsi; s->control_generation = ++s->nextGeneration; s->control_received.clear();
        s->input->resetLocks();
        s->control_ready = true; lws_callback_on_writable(wsi);
        return 0;
      }
      return s->startStream(wsi, socket, plan, response->clipboard);
    }
    case LWS_CALLBACK_RECEIVE: {
      if (s->closing.count(wsi)) return 0;
      if (const auto* response = static_cast<HttpResponse*>(user); response && response->grant_id &&
          !s->grants.active(response->grant_id, Grants::Clock::now())) { s->expireGrants(); return 0; }
      auto* slot = s->slotFor(wsi);
      if (!slot && s->control != wsi) return -1;
      auto& received = slot ? slot->sub->received : s->control_received;
      if (!lws_frame_is_binary(wsi) || len > 65536 - received.size()) return -1;
      received.insert(received.end(), static_cast<uint8_t*>(in), static_cast<uint8_t*>(in) + len);
      if (received.size() > 36) return -1;
      if (lws_is_final_fragment(wsi) && !lws_remaining_packet_payload(wsi)) {
        if (!(slot ? s->streamMessage(*slot) : s->controlMessage())) return -1;
        received.clear();
      }
      return 0;
    }
    case LWS_CALLBACK_SERVER_WRITEABLE: {
      if (s->closing.count(wsi)) return 0;
      if (const auto* response = static_cast<HttpResponse*>(user); response && response->grant_id &&
          !s->grants.active(response->grant_id, Grants::Clock::now())) { s->expireGrants(); return 0; }
      if (auto* slot = s->slotFor(wsi)) {
        const int result = s->writeSlot(*slot);
        if (slot->width) { s->width = slot->width; s->height = slot->height; }
        return result;
      }
      return s->control == wsi ? s->writeControl(wsi) : -1;
    }
    case LWS_CALLBACK_EVENT_WAIT_CANCELLED: {
      for (auto& slot : s->viewers) if (slot.viewer) {
        s->updateSlotFlow(slot);
        lws_callback_on_writable(slot.viewer);
      }
      if (s->control) lws_callback_on_writable(s->control);
#ifdef RELAY_RTC
      if (s->rtc.offer.stage == Server::RtcOfferStage::gathering && s->rtc.offer.session) {
        std::string answer, error;
        const bool settled = s->rtc.offer.session->takeAnswer(answer, error);
        const RtcOfferOutcome outcome = classifyRtcOffer(settled, !answer.empty() && error.empty(), s->rtc.offer.session->closed());
        if (outcome != RtcOfferOutcome::waiting) {
          auto finished = std::move(s->rtc.offer.session);
          lws* client = s->rtc.offer.client;
          const bool offer_can_input = s->rtc.offer.can_input;
          const uint64_t offer_grant_id = s->rtc.offer.grant_id;
          s->rtc.offer.stage = Server::RtcOfferStage::none;
          s->rtc.offer.client = nullptr;
          s->rtc.offer.can_input = false;
          s->rtc.offer.grant_id = 0;
          if (client) lws_set_timer_usecs(client, LWS_SET_TIMER_USEC_CANCEL);
          auto* response = client ? static_cast<HttpResponse*>(lws_wsi_user(client)) : nullptr;
          const bool grant_expired = offer_grant_id != 0 && !s->grants.active(offer_grant_id, Grants::Clock::now());
          const RtcAdmission admission = s->planRtcAdmission(offer_grant_id);
          const bool generation_exhausted = s->nextGeneration == UINT32_MAX || s->rtc.next_session_id == UINT64_MAX;
          if (outcome == RtcOfferOutcome::failed || grant_expired || !admission.allowed || generation_exhausted || !client || !response) {
            finished->close();
            if (client && response) {
              const std::string code = grant_expired ? "unauthorized"
                                     : (!admission.allowed || generation_exhausted) ? "viewer_limit"
                                     : (error.empty() ? "rtc_failed" : error);
              const unsigned status = grant_expired ? HTTP_STATUS_UNAUTHORIZED
                                    : (!admission.allowed || generation_exhausted) ? HTTP_STATUS_SERVICE_UNAVAILABLE
                                    : rtcOfferErrorStatus(code);
              const std::string body = "{\"error\":" + jsonString(code) + "}";
              response->image = new std::vector<uint8_t>(body.begin(), body.end());
              response->image_status = status;
              response->image_type = "application/json";
              response->image_headers = false; response->offset = 0;
              lws_callback_on_writable(client);
            }
          } else if (offer_grant_id != 0 && !s->grants.reserve(offer_grant_id)) {
            finished->close();
            const std::string body = "{\"error\":\"unauthorized\"}";
            response->image = new std::vector<uint8_t>(body.begin(), body.end());
            response->image_status = HTTP_STATUS_UNAUTHORIZED;
            response->image_type = "application/json";
            response->image_headers = false; response->offset = 0;
            lws_callback_on_writable(client);
          } else {
            std::weak_ptr<RtcSession> weak_rtc = finished;
            StreamHub::SubscriberSinks sinks;
            sinks.frame = [weak_rtc](const std::shared_ptr<const EncodedFrame>& frame, uint32_t generation, uint32_t sequence) {
              if (auto locked = weak_rtc.lock()) locked->pushFrame(frame, generation, sequence);
            };
            sinks.cursor = [weak_rtc](uint32_t generation, const CursorImage& cursor) {
              if (auto locked = weak_rtc.lock()) locked->pushCursor(generation, cursor);
            };
            sinks.clipboard = [weak_rtc](uint32_t generation) {
              if (auto locked = weak_rtc.lock()) locked->pushClipboardNotice(generation);
            };
            const SubscriberRole role = offer_can_input ? SubscriberRole::rtc : SubscriberRole::watch;
            auto sub = s->hub.attach(role, ++s->nextGeneration, offer_grant_id == 0, std::move(sinks));
            if (!sub) {
              if (offer_grant_id != 0) s->grants.release(offer_grant_id);
              finished->close();
              const std::string body = "{\"error\":\"capture_unavailable\"}";
              response->image = new std::vector<uint8_t>(body.begin(), body.end());
              response->image_status = HTTP_STATUS_SERVICE_UNAVAILABLE;
              response->image_type = "application/json";
              response->image_headers = false; response->offset = 0;
              lws_callback_on_writable(client);
            } else {
              if (admission.replace) {
                auto replace = std::find_if(s->rtc.active.begin(), s->rtc.active.end(),
                    [offer_grant_id](const Server::ActiveRtcSession& active) {
                      return offer_grant_id ? active.grant_id == offer_grant_id : active.grant_id != 0;
                    });
                if (replace == s->rtc.active.end() && !offer_grant_id) {
                  replace = s->rtc.active.begin();
                }
                if (replace != s->rtc.active.end()) {
                  s->closeActiveRtc(size_t(replace - s->rtc.active.begin()));
                } else {
                  lws* victim = nullptr;
                  for (auto& slot : s->viewers) {
                    if (!slot.viewer) continue;
                    const auto* r = static_cast<HttpResponse*>(lws_wsi_user(slot.viewer));
                    if (!offer_grant_id && r && r->grant_id) { victim = slot.viewer; break; }
                    if (!victim) victim = slot.viewer;
                  }
                  if (victim) { s->evict(victim); s->endStream(victim, false); }
                }
              }
              const uint64_t session_id = ++s->rtc.next_session_id;
              s->rtc.active.push_back({session_id, std::move(finished), sub, sub->id, offer_grant_id,
                                       offer_can_input, false, offer_grant_id == 0});
              s->assignRtcInput();
              response->rtc_session_id = session_id;
              response->image = new std::vector<uint8_t>(answer.begin(), answer.end());
              response->image_status = 201;
              response->image_type = "application/sdp";
              response->image_headers = false; response->offset = 0;
              lws_callback_on_writable(client);
            }
          }
        }
      }
      for (size_t i = s->rtc.active.size(); i > 0; --i) {
        auto& active = s->rtc.active[i - 1];
        if (active.grant_id && active.session->everConnected()) s->grants.commit(active.grant_id);
        if ((active.grant_id && !s->grants.active(active.grant_id, Grants::Clock::now())) || active.session->closed()) {
          s->closeActiveRtc(i - 1);
          continue;
        }
        for (const auto& ack : active.session->takeAcks()) {
          const uint64_t now = nowUs();
          if (s->hub.acknowledge(active.sub, ack.generation, ack.sequence, now, ack.wait_us)) {
            unsigned window = 1;
            uint64_t deadline = 0;
            uint32_t lowat = 0;
            s->hub.updateFlow(active.sub, now, std::nullopt, window, deadline, lowat);
          }
        }
        for (const auto& record : active.session->takeInput()) {
          if (active.owns_input && !s->input_viewer && !s->control &&
              s->input && s->input->pending() < max_queued_events) {
            s->input->apply(inputEvent(record.data()));
          }
        }
      }
      s->assignRtcInput();
#endif
      for (const auto& reply : s->readyInputs()) {
        auto* response = reply->wsi ? static_cast<HttpResponse*>(lws_wsi_user(reply->wsi)) : nullptr;
        if (!response) continue;
        std::memcpy(response->body, reply->body.data(), reply->body.size());
        response->length = reply->body.size();
        response->reply_status = reply->status;
        response->input_reply = true; response->input_headers = false;
        lws_callback_on_writable(reply->wsi);
      }
      if (s->clipboard_changed.exchange(false)) {
        s->hub.notifyClipboard();
        for (const auto& slot : s->viewers) if (slot.viewer && slot.sub && slot.sub->clipboard_notices) {
          lws_callback_on_writable(slot.viewer);
        }
      }
      for (auto& reply : s->clipboard.take()) {
        auto* response = static_cast<HttpResponse*>(lws_wsi_user(reply.client));
        if (!response) continue;
        response->image = new std::vector<uint8_t>(reply.body.begin(), reply.body.end());
        response->image_status = reply.status; response->image_type = "application/json";
        response->image_headers = false; response->offset = 0;
        lws_callback_on_writable(reply.client);
      }
      std::vector<uint8_t> image; std::string error;
      if (s->screenshot.take(image, error)) {
        if (!s->screenshot_client) { s->screenshot.finish(); return 0; }
        auto* response = static_cast<HttpResponse*>(lws_wsi_user(s->screenshot_client));
        if (!response) { s->screenshot_client = nullptr; s->screenshot.finish(); return 0; }
        response->image_status = error.empty() ? HTTP_STATUS_OK : HTTP_STATUS_SERVICE_UNAVAILABLE;
        response->image_type = error.empty() ? "image/png" : "application/json";
        if (!error.empty()) {
          std::cerr << "Screenshot failed: " << error << '\n';
          const std::string body = "{\"error\":\"screenshot_unavailable\"}";
          image.assign(body.begin(), body.end());
        }
        response->image = new std::vector<uint8_t>(std::move(image));
        lws_callback_on_writable(s->screenshot_client);
      }
      return 0;
    }
    case LWS_CALLBACK_TIMER:
      if (s->closing.erase(wsi)) return -1;
      if (s->screenshot_client == wsi) { closeScreenshot(s, wsi, static_cast<HttpResponse*>(user)); return -1; }
#ifdef RELAY_RTC
      if (s->rtc.offer.client == wsi) {
        const bool gathering = s->rtc.offer.stage == Server::RtcOfferStage::gathering;
        s->abortPendingRtc(false);
        if (gathering) {
          auto* response = static_cast<HttpResponse*>(user);
          if (response && !response->image) {
            const std::string body = "{\"error\":\"rtc_timeout\"}";
            response->image = new std::vector<uint8_t>(body.begin(), body.end());
            response->image_status = HTTP_STATUS_SERVICE_UNAVAILABLE;
            response->image_type = "application/json";
            response->image_headers = false; response->offset = 0;
            lws_callback_on_writable(wsi);
            return 0;
          }
        }
        return -1;
      }
#endif
      if (auto* slot = s->slotFor(wsi)) {
        slot->sub->flow_timer_due_us = 0;
        if (s->hub.timedOut(slot->sub, nowUs())) {
          std::cerr << "Viewer capture or flow failed\n"; s->endStream(wsi); return -1;
        }
        s->updateSlotFlow(*slot);
        return 0;
      }
      return -1;
    case LWS_CALLBACK_CLOSED:
      s->closing.erase(wsi);
      s->endStream(wsi);
      if (s->control == wsi) s->endControl();
#ifdef RELAY_RTC
      s->assignRtcInput();
#endif
      return 0;
    default: return 0;
  }
}
}  // namespace relay
