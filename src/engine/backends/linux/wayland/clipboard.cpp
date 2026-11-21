#include "core/clipboard.hpp"
#include "wlr-data-control-unstable-v1-client-protocol.h"
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <wayland-client.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace relay {
namespace {
using Clock = std::chrono::steady_clock;
/// MIME type the engine adds to its own offers, so a read can tell the selection is its own.
constexpr char ownType[] = "application/x-screen-relay";
constexpr const char* textTypes[] = {"text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"};
/// Milliseconds left until deadline, at least zero.
int remaining(Clock::time_point deadline) {
  return int(std::max<long long>(0, std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count()));
}
/**
 * The clipboard selection of a wlroots compositor through wlr-data-control, on its own connection and thread.
 * A write offers the text as a data source that answers paste requests until another client takes the selection.
 * A read receives the selection through a pipe and gives up after two seconds.
 * The selection ends with the engine, since a Wayland data source lives in its client.
 */
class WaylandClipboard final : public ClipboardBackend {
  struct Request {
    std::optional<std::string> text, result;
    bool ok = false, done = false;
  };
  ClipboardChanged changed;
  wl_display* display = nullptr;
  wl_registry* registry = nullptr;
  wl_seat* seat = nullptr;
  zwlr_data_control_manager_v1* manager = nullptr;
  zwlr_data_control_device_v1* device = nullptr;
  zwlr_data_control_source_v1* source = nullptr;
  zwlr_data_control_offer_v1* selection = nullptr;
  std::map<zwlr_data_control_offer_v1*, std::vector<std::string>> offers;
  std::string owned;
  int wake[2] = {-1, -1};
  std::mutex mutex;
  std::condition_variable finished;
  Request* pending = nullptr;
  bool stopping = false, broken = false;
  std::thread thread;

  static void global(void* data, wl_registry* registry, uint32_t name, const char* interface, uint32_t version) {
    auto* self = static_cast<WaylandClipboard*>(data);
    if (!std::strcmp(interface, wl_seat_interface.name) && !self->seat) {
      self->seat = static_cast<wl_seat*>(wl_registry_bind(registry, name, &wl_seat_interface, 1));
    } else if (!std::strcmp(interface, zwlr_data_control_manager_v1_interface.name) && !self->manager) {
      self->manager = static_cast<zwlr_data_control_manager_v1*>(
          wl_registry_bind(registry, name, &zwlr_data_control_manager_v1_interface, std::min(version, 2u)));
    }
  }
  static void globalRemove(void*, wl_registry*, uint32_t) {}
  static void offerType(void* data, zwlr_data_control_offer_v1* offer, const char* type) {
    auto* self = static_cast<WaylandClipboard*>(data);
    const auto entry = self->offers.find(offer);
    if (entry != self->offers.end()) entry->second.emplace_back(type);
  }
  static void dataOffer(void* data, zwlr_data_control_device_v1*, zwlr_data_control_offer_v1* offer) {
    static const zwlr_data_control_offer_v1_listener listener = {offerType};
    auto* self = static_cast<WaylandClipboard*>(data);
    self->offers[offer];
    zwlr_data_control_offer_v1_add_listener(offer, &listener, self);
  }
  void forget(zwlr_data_control_offer_v1* offer) {
    if (!offer) return;
    offers.erase(offer);
    zwlr_data_control_offer_v1_destroy(offer);
  }
  static bool isOwnOffer(const std::vector<std::string>& types) {
    return std::find(types.begin(), types.end(), ownType) != types.end();
  }
  static void selectionChanged(void* data, zwlr_data_control_device_v1*, zwlr_data_control_offer_v1* offer) {
    auto* self = static_cast<WaylandClipboard*>(data);
    if (self->selection != offer) self->forget(self->selection);
    self->selection = offer;
    const auto entry = self->offers.find(offer);
    if (entry == self->offers.end() || !isOwnOffer(entry->second)) self->changed();
  }
  static void primarySelection(void* data, zwlr_data_control_device_v1*, zwlr_data_control_offer_v1* offer) {
    auto* self = static_cast<WaylandClipboard*>(data);
    if (offer != self->selection) self->forget(offer);
  }
  static void deviceFinished(void* data, zwlr_data_control_device_v1*) {
    static_cast<WaylandClipboard*>(data)->broken = true;
  }
  static void send(void* data, zwlr_data_control_source_v1*, const char* mime, int32_t fd) {
    const std::string& owned = static_cast<WaylandClipboard*>(data)->owned;
    const bool latin1 = std::strcmp(mime, "STRING") == 0;
    const std::string converted = latin1 ? clipboard_detail::toLatin1(owned) : std::string();
    const std::string& text = latin1 ? converted : owned;
    fcntl(fd, F_SETFL, O_NONBLOCK);
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    for (size_t sent = 0; sent < text.size();) {
      const ssize_t written = ::write(fd, text.data() + sent, text.size() - sent);
      if (written > 0) { sent += size_t(written); continue; }
      pollfd ready{fd, POLLOUT, 0};
      if (written < 0 && errno != EAGAIN && errno != EINTR) break;
      if (poll(&ready, 1, remaining(deadline)) <= 0) break;
    }
    close(fd);
  }
  static void cancelled(void* data, zwlr_data_control_source_v1* cancelledSource) {
    auto* self = static_cast<WaylandClipboard*>(data);
    zwlr_data_control_source_v1_destroy(cancelledSource);
    if (self->source == cancelledSource) self->source = nullptr;
  }

  std::optional<std::string> readHere() {
    if (!selection) return std::string();
    const auto& types = offers[selection];
    if (isOwnOffer(types)) return owned;
    const char* chosen = nullptr;
    for (const char* type : textTypes) {
      if (std::find(types.begin(), types.end(), type) != types.end()) { chosen = type; break; }
    }
    if (!chosen) return std::string();
    int fds[2];
    if (pipe2(fds, O_CLOEXEC)) return std::nullopt;
    fcntl(fds[0], F_SETFL, O_NONBLOCK);
    zwlr_data_control_offer_v1_receive(selection, chosen, fds[1]);
    close(fds[1]);
    wl_display_flush(display);
    std::string text;
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    char buffer[65536];
    for (;;) {
      const ssize_t count = ::read(fds[0], buffer, sizeof(buffer));
      if (count == 0) break;
      if (count > 0) {
        if (text.size() <= max_clipboard_bytes) text.append(buffer, size_t(count));
        if (!remaining(deadline)) { close(fds[0]); return std::nullopt; }
        continue;
      }
      pollfd ready{fds[0], POLLIN, 0};
      if ((errno != EAGAIN && errno != EINTR) || poll(&ready, 1, remaining(deadline)) <= 0) { close(fds[0]); return std::nullopt; }
    }
    close(fds[0]);
    return text;
  }
  bool writeHere(const std::string& text) {
    static const zwlr_data_control_source_v1_listener listener = {send, cancelled};
    auto* next = zwlr_data_control_manager_v1_create_data_source(manager);
    zwlr_data_control_source_v1_add_listener(next, &listener, this);
    for (const char* type : textTypes) zwlr_data_control_source_v1_offer(next, type);
    zwlr_data_control_source_v1_offer(next, ownType);
    owned = text;
    zwlr_data_control_device_v1_set_selection(device, next);
    if (source) zwlr_data_control_source_v1_destroy(source);
    source = next;
    return wl_display_roundtrip(display) >= 0 && !broken;
  }
  void run() {
    pollfd fds[2] = {{wl_display_get_fd(display), POLLIN, 0}, {wake[0], POLLIN, 0}};
    for (;;) {
      while (wl_display_prepare_read(display)) wl_display_dispatch_pending(display);
      wl_display_flush(display);
      if (poll(fds, 2, -1) < 0) { wl_display_cancel_read(display); continue; }
      if (fds[0].revents & POLLIN) {
        if (wl_display_read_events(display) < 0) broken = true;
      } else {
        wl_display_cancel_read(display);
      }
      if (fds[0].revents & (POLLERR | POLLHUP)) broken = true;
      if (broken) fds[0].fd = -1;
      wl_display_dispatch_pending(display);
      char drained[16];
      while (::read(wake[0], drained, sizeof(drained)) > 0) {}
      Request* request = nullptr;
      { std::lock_guard<std::mutex> lock(mutex);
        if (stopping) return;
        std::swap(request, pending);
      }
      if (!request) continue;
      std::optional<std::string> result;
      const bool ok = !broken && (request->text ? writeHere(*request->text) : bool(result = readHere()));
      std::lock_guard<std::mutex> lock(mutex);
      request->result = std::move(result);
      request->ok = ok;
      request->done = true;
      finished.notify_all();
    }
  }
  bool call(Request& request) {
    std::unique_lock<std::mutex> lock(mutex);
    pending = &request;
    const char signal = 1;
    if (::write(wake[1], &signal, 1) < 0) {}
    finished.wait(lock, [&] { return request.done; });
    return request.ok;
  }
  void cleanup() {
    for (auto& entry : offers) zwlr_data_control_offer_v1_destroy(entry.first);
    offers.clear();
    if (source) zwlr_data_control_source_v1_destroy(source);
    if (device) zwlr_data_control_device_v1_destroy(device);
    if (manager) zwlr_data_control_manager_v1_destroy(manager);
    if (seat) wl_seat_destroy(seat);
    if (registry) wl_registry_destroy(registry);
    if (display) wl_display_disconnect(display);
    for (const int fd : wake) if (fd >= 0) close(fd);
  }

 public:
  explicit WaylandClipboard(ClipboardChanged callback) : changed(std::move(callback)) {
    static const wl_registry_listener registryListener = {global, globalRemove};
    static const zwlr_data_control_device_v1_listener deviceListener = {dataOffer, selectionChanged, deviceFinished, primarySelection};
    display = wl_display_connect(nullptr);
    if (!display) throw std::runtime_error("cannot connect to the Wayland display for the clipboard");
    registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registryListener, this);
    if (wl_display_roundtrip(display) < 0 || !seat || !manager || pipe2(wake, O_CLOEXEC | O_NONBLOCK)) {
      cleanup();
      throw std::runtime_error("the compositor has no wlr-data-control clipboard");
    }
    device = zwlr_data_control_manager_v1_get_data_device(manager, seat);
    zwlr_data_control_device_v1_add_listener(device, &deviceListener, this);
    if (wl_display_roundtrip(display) < 0) { cleanup(); throw std::runtime_error("Wayland clipboard roundtrip failed"); }
    thread = std::thread([this] { run(); });
  }
  ~WaylandClipboard() override {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    const char signal = 1;
    if (::write(wake[1], &signal, 1) < 0) {}
    thread.join();
    cleanup();
  }
  std::optional<std::string> read() override {
    Request request;
    call(request);
    return request.result;
  }
  bool write(const std::string& text) override {
    Request request;
    request.text = text;
    return call(request);
  }
};
}  // namespace
namespace wayland {
std::unique_ptr<ClipboardBackend> makeClipboard(ClipboardChanged changed) {
  return std::make_unique<WaylandClipboard>(std::move(changed));
}
}  // namespace wayland
}  // namespace relay
