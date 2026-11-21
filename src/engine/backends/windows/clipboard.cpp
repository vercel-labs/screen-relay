#include "core/clipboard.hpp"
#include <windows.h>
#include <cstring>
#include <cwchar>
#include <future>
#include <limits>
#include <memory>
#include <stdexcept>
#include <thread>
#include <utility>

namespace relay {
namespace {
constexpr UINT readMessage = WM_APP + 1, writeMessage = WM_APP + 2;
/// Opens the clipboard for owner, retrying for up to 500 ms while another application holds it.
bool openClipboard(HWND owner) {
  for (int attempt = 0; attempt < 50; ++attempt) {
    if (OpenClipboard(owner)) return true;
    Sleep(10);
  }
  return false;
}
/// UTF-8 for UTF-16 clipboard text, with CRLF turned into LF and unpaired surrogates into U+FFFD.
std::string utf8(const wchar_t* text, size_t length) {
  std::wstring lines;
  lines.reserve(length);
  for (size_t i = 0; i < length; ++i) if (!(text[i] == L'\r' && i + 1 < length && text[i + 1] == L'\n')) lines.push_back(text[i]);
  if (lines.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, lines.data(), int(lines.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size_t(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, lines.data(), int(lines.size()), result.data(), size, nullptr, nullptr);
  return result;
}
std::optional<std::string> ansiUtf8(const char* text, size_t length) {
  if (!length) return std::string();
  if (length > size_t(std::numeric_limits<int>::max())) return std::nullopt;
  const int size = MultiByteToWideChar(CP_ACP, 0, text, int(length), nullptr, 0);
  if (!size) return std::nullopt;
  std::wstring wide(size_t(size), L'\0');
  if (!MultiByteToWideChar(CP_ACP, 0, text, int(length), wide.data(), size)) return std::nullopt;
  return utf8(wide.data(), wide.size());
}
/// UTF-16 for UTF-8 text with LF turned into CRLF; empty when the text is not valid UTF-8.
std::wstring utf16(const std::string& text) {
  std::wstring wide;
  if (!text.empty()) {
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), nullptr, 0);
    if (size <= 0) return {};
    wide.assign(size_t(size), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), wide.data(), size);
  }
  std::wstring lines;
  for (size_t i = 0; i < wide.size(); ++i) {
    if (wide[i] == L'\n' && (i == 0 || wide[i - 1] != L'\r')) lines.push_back(L'\r');
    lines.push_back(wide[i]);
  }
  return lines;
}
/**
 * The clipboard of the interactive window station. A thread owns a message-only window that listens for
 * WM_CLIPBOARDUPDATE and runs every clipboard call, so the window that opens the clipboard always belongs to it.
 */
class WindowsClipboard final : public ClipboardBackend {
  ClipboardChanged changed;
  HWND window = nullptr;
  DWORD written_sequence = 0;
  std::thread thread;

  static LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* self = reinterpret_cast<WindowsClipboard*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    switch (message) {
      case WM_CLIPBOARDUPDATE:
        if (!self || GetClipboardOwner() == hwnd ||
            (self->written_sequence && GetClipboardSequenceNumber() == self->written_sequence)) return 0;
        self->changed();
        return 0;
      case readMessage: *reinterpret_cast<std::optional<std::string>*>(lparam) = self->readHere(); return 0;
      case writeMessage: return self->writeHere(*reinterpret_cast<const std::string*>(lparam));
      case WM_CLOSE: DestroyWindow(hwnd); return 0;
      case WM_DESTROY: RemoveClipboardFormatListener(hwnd); PostQuitMessage(0); return 0;
      default: return DefWindowProcW(hwnd, message, wparam, lparam);
    }
  }
  std::optional<std::string> readHere() {
    if (!openClipboard(window)) return std::nullopt;
    std::optional<std::string> text = std::string();
    const bool unicode = IsClipboardFormatAvailable(CF_UNICODETEXT);
    if (HANDLE data = GetClipboardData(unicode ? CF_UNICODETEXT : CF_TEXT)) {
      if (const void* bytes = GlobalLock(data)) {
        const size_t size = GlobalSize(data);
        if (unicode) {
          const auto* wide = static_cast<const wchar_t*>(bytes);
          text = utf8(wide, wcsnlen(wide, size / sizeof(wchar_t)));
        } else {
          const auto* ansi = static_cast<const char*>(bytes);
          const auto* end = static_cast<const char*>(std::memchr(ansi, '\0', size));
          text = ansiUtf8(ansi, end ? size_t(end - ansi) : size);
        }
        GlobalUnlock(data);
      } else {
        text.reset();
      }
    }
    CloseClipboard();
    return text;
  }
  bool writeHere(const std::string& text) {
    const std::wstring wide = utf16(text);
    if (wide.empty() && !text.empty()) return false;
    HGLOBAL data = GlobalAlloc(GMEM_MOVEABLE, (wide.size() + 1) * sizeof(wchar_t));
    if (!data) return false;
    auto* target = static_cast<wchar_t*>(GlobalLock(data));
    std::wmemcpy(target, wide.c_str(), wide.size() + 1);
    GlobalUnlock(data);
    if (!openClipboard(window)) { GlobalFree(data); return false; }
    const bool written = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, data);
    if (written) written_sequence = GetClipboardSequenceNumber();
    CloseClipboard();
    if (!written) GlobalFree(data);
    return written;
  }
  void run(std::promise<HWND>& ready) {
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW type{};
    type.lpfnWndProc = procedure;
    type.hInstance = instance;
    type.lpszClassName = L"RelayClipboard";
    RegisterClassW(&type);
    HWND hwnd = CreateWindowExW(0, type.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, instance, nullptr);
    if (hwnd) {
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
      if (!AddClipboardFormatListener(hwnd)) { DestroyWindow(hwnd); hwnd = nullptr; }
    }
    ready.set_value(hwnd);
    if (!hwnd) return;
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) DispatchMessageW(&message);
  }

 public:
  explicit WindowsClipboard(ClipboardChanged callback) : changed(std::move(callback)) {
    std::promise<HWND> ready;
    auto created = ready.get_future();
    thread = std::thread([this, &ready] { run(ready); });
    window = created.get();
    if (!window) { thread.join(); throw std::runtime_error("cannot create the clipboard window"); }
  }
  ~WindowsClipboard() override {
    PostMessageW(window, WM_CLOSE, 0, 0);
    thread.join();
  }
  std::optional<std::string> read() override {
    std::optional<std::string> text;
    SendMessageW(window, readMessage, 0, reinterpret_cast<LPARAM>(&text));
    return text;
  }
  bool write(const std::string& text) override {
    return SendMessageW(window, writeMessage, 0, reinterpret_cast<LPARAM>(&text)) != 0;
  }
};
}  // namespace
namespace windows {
std::unique_ptr<ClipboardBackend> makeClipboard(ClipboardChanged changed) {
  return std::make_unique<WindowsClipboard>(std::move(changed));
}
}  // namespace windows
}  // namespace relay
