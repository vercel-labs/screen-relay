#include "core/clipboard.hpp"
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xproto.h>
#include <X11/extensions/Xfixes.h>
#include <poll.h>
#include <unistd.h>
#include <chrono>
#include <condition_variable>
#include <fcntl.h>
#include <iterator>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace relay {
namespace {
using Clock = std::chrono::steady_clock;
XErrorHandler previousHandler = nullptr;
/// Ignores BadWindow from a clipboard reply to a window that closed first, and passes every other error on.
int ignoreClosedRequestor(Display* display, XErrorEvent* error) {
  if (error->error_code == BadWindow && (error->request_code == X_ChangeProperty || error->request_code == X_SendEvent)) return 0;
  return previousHandler ? previousHandler(display, error) : 0;
}
/// UTF-8 for Latin-1 text.
std::string fromLatin1(const std::string& text) {
  std::string out;
  for (const unsigned char c : text) {
    if (c < 0x80) { out += char(c); continue; }
    out += char(0xc0 | (c >> 6)); out += char(0x80 | (c & 0x3f));
  }
  return out;
}
/**
 * The CLIPBOARD selection on its own X connection and thread. A write makes the engine the selection owner, which
 * answers other clients until one of them takes the selection. A read converts the selection into a property on the
 * engine's window, following INCR transfers, and gives up after two seconds. XFixes reports every owner change.
 * The selection ends with the engine, since an X selection lives in its owner.
 */
class X11Clipboard final : public ClipboardBackend {
  struct Request {
    std::optional<std::string> text, result;
    bool ok = false, done = false;
  };
  enum class Transfer { idle, converting, incremental };
  ClipboardChanged changed;
  Display* display = nullptr;
  Window window = 0;
  Atom clipboard = 0, utf8 = 0, textPlainUtf8 = 0, textPlain = 0;
  Atom targets = 0, textTarget = 0, timestampAtom = 0, incr = 0, property = 0;
  Time ownedTime = CurrentTime;
  int fixesEvent = 0, wake[2] = {-1, -1};
  size_t maxProperty = 0;
  std::optional<std::string> owned;
  std::mutex mutex;
  std::condition_variable finished;
  Request* pending = nullptr;
  Request* active = nullptr;
  bool stopping = false;
  Transfer transfer = Transfer::idle;
  Atom requested = 0;
  std::string received;
  Clock::time_point deadline;
  std::thread thread;

  void finish(std::optional<std::string> result, bool ok) {
    transfer = Transfer::idle;
    received.clear();
    std::lock_guard<std::mutex> lock(mutex);
    active->result = std::move(result);
    active->ok = ok;
    active->done = true;
    active = nullptr;
    finished.notify_all();
  }
  void expire() {
    XDeleteProperty(display, window, property);
    XFlush(display);
    finish(std::nullopt, false);
  }
  void convert(Atom target) {
    requested = target;
    transfer = Transfer::converting;
    XConvertSelection(display, clipboard, target, property, window, CurrentTime);
    XFlush(display);
  }
  void start(Request* request) {
    active = request;
    if (request->text) {
      owned = request->text;
      ownedTime = CurrentTime;
      XSetSelectionOwner(display, clipboard, window, CurrentTime);
      const bool ok = XGetSelectionOwner(display, clipboard) == window;
      if (!ok) owned.reset();
      finish(std::nullopt, ok);
      return;
    }
    const Window owner = XGetSelectionOwner(display, clipboard);
    if (owner == window && owned) { finish(owned, true); return; }
    if (owner == None) { finish(std::string(), true); return; }
    deadline = Clock::now() + std::chrono::seconds(2);
    convert(utf8);
  }
  /// Appends property bytes to the transfer and reports their type, keeping at most one byte past the limit.
  Atom take(bool& more, size_t& count) {
    Atom type = None;
    int format = 0;
    unsigned long items = 0, after = 0;
    unsigned char* data = nullptr;
    XGetWindowProperty(display, window, property, 0, long(max_clipboard_bytes / 4 + 1), True, AnyPropertyType, &type,
                       &format, &items, &after, &data);
    count = format == 8 ? items : 0;
    if (data && type != incr && received.size() <= max_clipboard_bytes) received.append(reinterpret_cast<char*>(data), count);
    more = after > 0;
    if (data) XFree(data);
    return type;
  }
  void selectionNotify(const XSelectionEvent& event) {
    if (transfer != Transfer::converting || event.requestor != window || event.selection != clipboard || event.target != requested) return;
    if (event.property == None) {
      if (requested == utf8) convert(textPlainUtf8);
      else if (requested == textPlainUtf8) convert(textPlain);
      else if (requested == textPlain) convert(XA_STRING);
      else finish(std::string(), true);
      return;
    }
    bool more = false;
    size_t count = 0;
    const Atom type = take(more, count);
    if (type == incr) { transfer = Transfer::incremental; return; }
    if (more) received.resize(max_clipboard_bytes + 1);
    finish(requested == XA_STRING ? fromLatin1(received) : received, true);
  }
  void propertyNotify(const XPropertyEvent& event) {
    if (transfer != Transfer::incremental || event.window != window || event.atom != property || event.state != PropertyNewValue) return;
    bool more = false;
    size_t count = 0;
    take(more, count);
    if (!count) finish(requested == XA_STRING ? fromLatin1(received) : received, true);
  }
  void selectionRequest(const XSelectionRequestEvent& request) {
    XSelectionEvent reply{};
    reply.type = SelectionNotify;
    reply.display = display;
    reply.requestor = request.requestor;
    reply.selection = request.selection;
    reply.target = request.target;
    reply.time = request.time;
    const Atom target = request.property == None ? request.target : request.property;
    if (request.selection == clipboard && owned) {
      if (request.target == targets) {
        const Atom offered[] = {targets, utf8, textPlainUtf8, textPlain, textTarget, XA_STRING, timestampAtom};
        XChangeProperty(display, request.requestor, target, XA_ATOM, 32, PropModeReplace,
                        reinterpret_cast<const unsigned char*>(offered), int(std::size(offered)));
        reply.property = target;
      } else if (request.target == timestampAtom) {
        XChangeProperty(display, request.requestor, target, XA_INTEGER, 32, PropModeReplace,
                        reinterpret_cast<const unsigned char*>(&ownedTime), 1);
        reply.property = target;
      } else if (request.target == utf8 || request.target == textPlainUtf8 || request.target == textPlain ||
                 request.target == textTarget || request.target == XA_STRING) {
        const bool latin1 = request.target == textTarget || request.target == XA_STRING;
        const std::string text = latin1 ? clipboard_detail::toLatin1(*owned) : *owned;
        if (text.size() <= maxProperty) {
          XChangeProperty(display, request.requestor, target, latin1 ? XA_STRING : request.target, 8,
                          PropModeReplace, reinterpret_cast<const unsigned char*>(text.data()), int(text.size()));
          reply.property = target;
        }
      }
    }
    XSendEvent(display, request.requestor, False, NoEventMask, reinterpret_cast<XEvent*>(&reply));
    XFlush(display);
  }
  void handle(XEvent& event) {
    if (event.type == fixesEvent + XFixesSelectionNotify) {
      const auto& fix = reinterpret_cast<const XFixesSelectionNotifyEvent&>(event);
      if (fix.subtype == XFixesSetSelectionOwnerNotify && fix.owner == window) {
        ownedTime = fix.selection_timestamp;
        return;
      }
      changed();
      return;
    }
    switch (event.type) {
      case SelectionNotify: selectionNotify(event.xselection); break;
      case PropertyNotify: propertyNotify(event.xproperty); break;
      case SelectionRequest: selectionRequest(event.xselectionrequest); break;
      case SelectionClear: if (event.xselectionclear.selection == clipboard) owned.reset(); break;
      default: break;
    }
  }
  void run() {
    pollfd fds[2] = {{ConnectionNumber(display), POLLIN, 0}, {wake[0], POLLIN, 0}};
    for (;;) {
      while (XPending(display)) {
        XEvent event;
        XNextEvent(display, &event);
        handle(event);
      }
      int timeout = -1;
      if (transfer != Transfer::idle) {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
        if (left <= 0) { expire(); continue; }
        timeout = int(left);
      }
      if (poll(fds, 2, timeout) < 0) continue;
      if (fds[1].revents & POLLIN) {
        char drained[16];
        while (::read(wake[0], drained, sizeof(drained)) > 0) {}
      }
      Request* next = nullptr;
      { std::lock_guard<std::mutex> lock(mutex);
        if (stopping) return;
        if (!active && pending) { next = pending; pending = nullptr; }
      }
      if (next) start(next);
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

 public:
  explicit X11Clipboard(ClipboardChanged callback) : changed(std::move(callback)) {
    display = XOpenDisplay(nullptr);
    if (!display) throw std::runtime_error("cannot open the X display for the clipboard");
    static std::once_flag handler;
    std::call_once(handler, [] { previousHandler = XSetErrorHandler(ignoreClosedRequestor); });
    int fixesError = 0;
    if (!XFixesQueryExtension(display, &fixesEvent, &fixesError) || pipe(wake)) {
      XCloseDisplay(display);
      throw std::runtime_error("the X clipboard needs XFixes");
    }
    fcntl(wake[0], F_SETFL, O_NONBLOCK);
    const Window root = DefaultRootWindow(display);
    window = XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0);
    XSelectInput(display, window, PropertyChangeMask);
    clipboard = XInternAtom(display, "CLIPBOARD", False);
    utf8 = XInternAtom(display, "UTF8_STRING", False);
    textPlainUtf8 = XInternAtom(display, "text/plain;charset=utf-8", False);
    textPlain = XInternAtom(display, "text/plain", False);
    targets = XInternAtom(display, "TARGETS", False);
    textTarget = XInternAtom(display, "TEXT", False);
    timestampAtom = XInternAtom(display, "TIMESTAMP", False);
    incr = XInternAtom(display, "INCR", False);
    property = XInternAtom(display, "RELAY_CLIPBOARD", False);
    const long units = XExtendedMaxRequestSize(display) ? XExtendedMaxRequestSize(display) : XMaxRequestSize(display);
    maxProperty = size_t(units) * 4 - 1024;
    XFixesSelectSelectionInput(display, root, clipboard, XFixesSetSelectionOwnerNotifyMask |
                               XFixesSelectionWindowDestroyNotifyMask | XFixesSelectionClientCloseNotifyMask);
    XFlush(display);
    thread = std::thread([this] { run(); });
  }
  ~X11Clipboard() override {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    const char signal = 1;
    if (::write(wake[1], &signal, 1) < 0) {}
    thread.join();
    XDestroyWindow(display, window);
    XCloseDisplay(display);
    close(wake[0]); close(wake[1]);
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
namespace x11 {
std::unique_ptr<ClipboardBackend> makeClipboard(ClipboardChanged changed) {
  return std::make_unique<X11Clipboard>(std::move(changed));
}
}  // namespace x11
}  // namespace relay
