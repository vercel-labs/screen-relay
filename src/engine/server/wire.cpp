#include "wire.hpp"
#include "config.hpp"
#include "core/capture-source.hpp"
#include "core/flow.hpp"
#include <libwebsockets.h>
#include <algorithm>
#include <cstring>

namespace relay {
namespace {
uint8_t* start(std::vector<uint8_t>& out, size_t pre, size_t size, uint8_t type, uint32_t generation) {
  out.assign(pre + size, 0);
  auto* p = out.data() + pre;
  std::memcpy(p, "NSL1", 4); p[4] = 1; p[5] = type;
  put(p+8, generation, 4);
  return p;
}
}  // namespace
uint16_t u16(const uint8_t* p) { return (uint16_t(p[0]) << 8) | p[1]; }
uint32_t u32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
void put(uint8_t* p, uint64_t value, unsigned count) {
  while (count) { p[--count] = uint8_t(value); value >>= 8; }
}
InputEvent inputEvent(const uint8_t* p) {
  const uint32_t raw = u32(p + 4);
  const int64_t value = raw <= INT32_MAX ? int64_t(raw) : int64_t(raw) - (int64_t(1) << 32);
  return {p[0], p[1], u16(p+2), int32_t(value), u16(p+8), u16(p+10), u16(p+12), u16(p+14)};
}
unsigned inputLength(const std::string& text, uint64_t& length) {
  if (text.empty()) return HTTP_STATUS_LENGTH_REQUIRED;
  if (!unsignedNumber(text, length) || !length || length % 16) return HTTP_STATUS_BAD_REQUEST;
  return length > max_input_batch * 16 ? HTTP_STATUS_REQ_ENTITY_TOO_LARGE : 0;
}
unsigned clipboardLength(const std::string& text, uint64_t& length) {
  if (text.empty()) return HTTP_STATUS_LENGTH_REQUIRED;
  if (!unsignedNumber(text, length)) return HTTP_STATUS_BAD_REQUEST;
  return length > max_clipboard_bytes ? HTTP_STATUS_REQ_ENTITY_TOO_LARGE : 0;
}
namespace {
/// Length of the UTF-8 sequence at i, or 0 when it is invalid, overlong, a surrogate, or past U+10FFFF.
size_t utf8Length(const std::string& text, size_t i) {
  const auto byte = [&](size_t at) { return at < text.size() ? uint8_t(text[at]) : uint8_t(0); };
  const uint8_t lead = byte(i);
  if (lead < 0x80) return 1;
  const size_t count = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  if (!count || i + count > text.size()) return 0;
  for (size_t k = 1; k < count; ++k) if ((byte(i + k) & 0xc0) != 0x80) return 0;
  const uint8_t next = byte(i + 1);
  if ((lead == 0xe0 && next < 0xa0) || (lead == 0xed && next > 0x9f) || (lead == 0xf0 && next < 0x90) || (lead == 0xf4 && next > 0x8f)) return 0;
  return count;
}
}  // namespace
bool validText(const std::string& text) {
  for (size_t i = 0; i < text.size();) {
    const size_t count = utf8Length(text, i);
    if (!count || !text[i]) return false;
    i += count;
  }
  return true;
}
std::string jsonString(const std::string& text) {
  static const char digits[] = "0123456789abcdef";
  std::string out = "\"";
  for (size_t i = 0; i < text.size();) {
    const size_t count = utf8Length(text, i);
    const uint8_t c = uint8_t(text[i]);
    if (!count) { out += "\\ufffd"; ++i; continue; }
    if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
    else if (c == '\n') out += "\\n";
    else if (c == '\t') out += "\\t";
    else if (c == '\r') out += "\\r";
    else if (c < 0x20) { out += "\\u00"; out += digits[c >> 4]; out += digits[c & 15]; }
    else out.append(text, i, count);
    i += count;
  }
  return out + '"';
}
Target viewerTarget(const std::string& target) {
  if (target == "/stream?view=1") return {Socket::watch, false};
  if (target == "/stream") return {Socket::stream, false};
  if (target == "/stream?clipboard=1") return {Socket::stream, true};
  if (target == "/stream?take=1") return {Socket::take, false};
  if (target == "/stream?take=1&clipboard=1") return {Socket::take, true};
  if (target == "/control") return {Socket::control, false};
  return {};
}
ConnectionPlan connectionPlan(Socket socket, size_t viewerCount, bool streamOwnsInput, bool controlOpen,
                              size_t grantViewerCount, bool grant, bool inputViewerHasGrant) {
  const bool idle = !streamOwnsInput && !controlOpen;
  const bool replacing = socket == Socket::take && streamOwnsInput && (!grant || inputViewerHasGrant);
  const bool capacity = viewerCount < max_viewers || (viewerCount == max_viewers && replacing);
  const bool grantCapacity = !grant || grantViewerCount < max_viewers - 1 ||
                             (grantViewerCount == max_viewers - 1 && replacing && inputViewerHasGrant);
  switch (socket) {
    case Socket::none: return {};
    case Socket::control: return {idle, false, false};
    case Socket::watch: return {capacity && grantCapacity, false, false};
    case Socket::stream: return {capacity && grantCapacity && idle, false, false};
    case Socket::take:
      return capacity && grantCapacity && (!grant || !streamOwnsInput || inputViewerHasGrant) ? ConnectionPlan{true, streamOwnsInput, controlOpen} : ConnectionPlan{};
  }
  return {};
}
bool rtcSessionAuthorized(bool callerIsOwner, uint64_t callerGrantId, uint64_t sessionGrantId) {
  if (callerIsOwner) return true;
  return callerGrantId != 0 && sessionGrantId != 0 && callerGrantId == sessionGrantId;
}
RtcAdmission rtcAdmission(size_t wsViewerCount, size_t wsGrantViewerCount,
                          size_t rtcViewerCount, size_t rtcGrantViewerCount, uint64_t callerGrantId, bool hasReplaceableGrantRtc) {
  const size_t total = wsViewerCount + rtcViewerCount;
  if (!callerGrantId) return {total <= max_viewers, total == max_viewers};
  const size_t grants = wsGrantViewerCount + rtcGrantViewerCount;
  if (total < max_viewers && grants < max_viewers - 1) return {true, false};
  const bool replace = hasReplaceableGrantRtc && rtcViewerCount && rtcGrantViewerCount &&
                       total <= max_viewers && grants <= max_viewers - 1;
  return {replace, replace};
}
bool frameMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t lastSequence, const EncodedFrame& f,
                  uint16_t width, uint16_t height) {
  return frameMessage(out, pre, generation, lastSequence, f.sequence, f, width, height);
}
bool frameMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t lastSequence, uint32_t sequence,
                  const EncodedFrame& f, uint16_t width, uint16_t height) {
  if (!sequence || sequence != lastSequence + 1 || !f.width || !f.height ||
      f.width > width || f.height > height || f.annex_b.empty() || f.annex_b.size() > FlowControl::max_bytes ||
      (!lastSequence && !f.keyframe)) return false;
  auto* p = start(out, pre, 32 + f.annex_b.size(), 1, generation);
  put(p+6, f.keyframe ? 1 : 0, 2); put(p+12, sequence, 4);
  put(p+16, 12+f.annex_b.size(), 4); put(p+20, f.width, 2); put(p+22, f.height, 2); put(p+24, f.pts_us, 8);
  std::memcpy(p+32, f.annex_b.data(), f.annex_b.size());
  return true;
}
bool cursorMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, const CursorImage& c) {
  if (c.width > CursorImage::max_extent || c.height > CursorImage::max_extent ||
      c.rgba.size() != size_t(c.width) * c.height * 4 ||
      (c.width && c.height ? c.xhot >= c.width || c.yhot >= c.height
                          : c.width || c.height || c.xhot || c.yhot)) return false;
  auto* p = start(out, pre, 28 + c.rgba.size(), 6, generation);
  put(p+16, 8 + c.rgba.size(), 4);
  put(p+20, c.width, 2); put(p+22, c.height, 2); put(p+24, c.xhot, 2); put(p+26, c.yhot, 2);
  std::copy(c.rgba.begin(), c.rgba.end(), p+28);
  return true;
}
void controlReady(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint16_t width, uint16_t height) {
  auto* p = start(out, pre, 24, 4, generation);
  put(p+16, 4, 4); put(p+20, width, 2); put(p+22, height, 2);
}
void clipboardNotice(std::vector<uint8_t>& out, size_t pre, uint32_t generation) { start(out, pre, 20, 7, generation); }
void inputReply(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t sequence, InputStatus status) {
  auto* p = start(out, pre, 21, 5, generation);
  put(p+12, sequence, 4); put(p+16, 1, 4);
  p[20] = uint8_t(status);
}
}  // namespace relay
