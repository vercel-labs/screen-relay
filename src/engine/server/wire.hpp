#pragma once

#include "core/capture.hpp"
#include "core/clipboard.hpp"
#include "core/input.hpp"
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace relay {
constexpr size_t max_input_batch = 256;
uint16_t u16(const uint8_t* p);
uint32_t u32(const uint8_t* p);
void put(uint8_t* p, uint64_t value, unsigned count);
InputEvent inputEvent(const uint8_t* p);
/** Validates an /input Content-Length header and returns 0 or the HTTP error status. */
unsigned inputLength(const std::string& text, uint64_t& length);
/** Validates a /clipboard Content-Length header and returns 0 or the HTTP error status; zero bytes clears the clipboard. */
unsigned clipboardLength(const std::string& text, uint64_t& length);
/** True for UTF-8 text without NUL, the only text the clipboard accepts. */
bool validText(const std::string& text);
/** A JSON string literal for text, with invalid UTF-8 replaced by U+FFFD. */
std::string jsonString(const std::string& text);
/** The WebSocket a request target opens. */
enum class Socket : uint8_t { none, watch, stream, take, control };
/** A request target: the socket it opens, and whether a /stream also wants clipboard notices. */
struct Target {
  Socket socket = Socket::none;
  bool clipboard = false;
};
/** Classifies /stream?view=1, /stream, /stream?take=1, /stream?clipboard=1, /stream?take=1&clipboard=1, and /control; any other target opens Socket::none. */
Target viewerTarget(const std::string& target);
/** What opening a socket does to the sockets already open. */
struct ConnectionPlan {
  bool open = false, closeStream = false, closeControl = false;
};
constexpr size_t max_viewers = 4;
constexpr uint16_t close_taken = 4001;
constexpr uint16_t close_busy = 4003;
/** Plans a connection without changing the current input owner or any active stream. */
ConnectionPlan connectionPlan(Socket socket, size_t viewerCount, bool streamOwnsInput, bool controlOpen,
                              size_t grantViewerCount, bool grant, bool inputViewerHasGrant);
/** True when a caller may replace or tear down an active WebRTC session owned by sessionGrantId (0 = session token owner). */
bool rtcSessionAuthorized(bool callerIsOwner, uint64_t callerGrantId, uint64_t sessionGrantId);
/** Result of checking whether a WebRTC offer fits total and delegated viewer limits. */
struct RtcAdmission {
  bool allowed = false;
  bool replace = false;
};
/** Checks total and delegated viewer limits and whether an owner must replace a viewer. */
RtcAdmission rtcAdmission(size_t wsViewerCount, size_t wsGrantViewerCount,
                          size_t rtcViewerCount, size_t rtcGrantViewerCount, uint64_t callerGrantId, bool hasReplaceableGrantRtc);
enum class RtcOfferOutcome : uint8_t { waiting, answered, failed };
/** Classifies a pending RTC offer from its answer gate and terminal closed state. */
RtcOfferOutcome classifyRtcOffer(bool settled, bool hasAnswer, bool sessionClosed);
/** Maps a settled RTC offer error code to the HTTP status code returned to the client. */
unsigned rtcOfferErrorStatus(const std::string& error);
/**
 * The builders below fill out with pre zero bytes of caller padding followed by one NSL1 message.
 * frameMessage and cursorMessage return false when the payload must not be sent.
 */
bool frameMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t lastSequence, const EncodedFrame& frame,
                  uint16_t width, uint16_t height);
/** Zero-copy NSL1 video builder using an explicit per-viewer sequence number for a shared EncodedFrame. */
bool frameMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t lastSequence, uint32_t sequence,
                  const EncodedFrame& frame, uint16_t width, uint16_t height);
bool cursorMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, const CursorImage& cursor);
void controlReady(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint16_t width, uint16_t height);
/** Tells a controlling /stream viewer that the desktop clipboard changed; it reads the text from /clipboard. */
void clipboardNotice(std::vector<uint8_t>& out, size_t pre, uint32_t generation);
void inputReply(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t sequence, InputStatus status);
}  // namespace relay
