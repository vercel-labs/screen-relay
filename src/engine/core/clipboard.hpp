#pragma once

#include <cstddef>
#include <functional>
#include <optional>
#include <string>

namespace relay {
/// Largest clipboard text, in UTF-8 bytes, that the engine reads or writes.
constexpr size_t max_clipboard_bytes = 256 * 1024;
namespace clipboard_detail {
/// Converts UTF-8 to Latin-1, replacing characters outside Latin-1 with '?'.
inline std::string toLatin1(const std::string& text) {
  std::string out;
  for (size_t i = 0; i < text.size();) {
    const unsigned char c = text[i];
    const size_t length = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    out += c < 0x80 ? char(c) : length == 2 && i + 1 < text.size() && c <= 0xc3 ? char(((c & 0x1f) << 6) | (text[i + 1] & 0x3f)) : '?';
    i += length;
  }
  return out;
}
}

/// Runs on a backend thread when a desktop application changes the clipboard, excluding the engine's own write().
using ClipboardChanged = std::function<void()>;
/** Platform text clipboard with LF line endings. One caller at a time; each call returns within about two seconds. */
class ClipboardBackend {
 public:
  virtual ~ClipboardBackend() = default;
  /// The clipboard text as UTF-8, empty when the clipboard holds no text, or nothing when it cannot be read in time.
  virtual std::optional<std::string> read() = 0;
  /// Replaces the clipboard with UTF-8 text; false when the desktop refused it.
  virtual bool write(const std::string& text) = 0;
};
}  // namespace relay
