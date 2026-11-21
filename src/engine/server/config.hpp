#pragma once

#include <libwebsockets.h>
#include <chrono>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace relay {
struct Config {
  std::string bind = "127.0.0.1", viewer, token, origin, authority, cert, key, backend, output, encoder = "auto";
  unsigned port = 8080;
  unsigned fps = 60;
  uint64_t bitrate_min = 1000000, bitrate_start = 8000000, bitrate_max = 40000000;
  bool proxy = false, insecure_local = false, check = false;
  std::vector<std::string> allowed_origins;
};
bool unsignedNumber(const std::string& text, uint64_t& value);
/** Fills config from argv and throws std::runtime_error on invalid options; returns false after printing --help. */
bool parseConfig(int argc, char** argv, Config& config);
bool secretEqual(const std::string& a, const std::string& b);
std::string header(lws* wsi, lws_token_indexes token);
bool authenticated(const Config& config, lws* wsi, bool websocket = false);
enum class GrantScope { watch, control };
class Grants {
 public:
  using Clock = std::chrono::steady_clock;
  static constexpr size_t capacity = 32;
  static constexpr uint64_t max_ttl = 3600;
  struct Grant {
    uint64_t id;
    std::string token;
    GrantScope scope;
    Clock::time_point expires;
    /** Opens one WebSocket only; `claimed` once it has. */
    bool single = false;
    bool claimed = false;
  };
  uint64_t issue(std::string token, GrantScope scope, Clock::time_point now, uint64_t ttl, bool single = false);
  /** The live grant for a token, leaving out a single-connection grant that already opened its connection. */
  const Grant* find(const std::string& token, Clock::time_point now) const;
  bool active(uint64_t id, Clock::time_point now) const;
  /** Records that a grant opened a connection; false when a single-connection grant already did. */
  bool claim(uint64_t id);
  bool revoke(uint64_t id);
 private:
  std::vector<Grant> grants;
  uint64_t last_id = 0;
};
/**
 * Fills out with bytes from the OS CSPRNG. lws_get_random isn't safe for
 * secrets: libwebsockets before 5.1 uses unseeded rand() on Windows.
 */
bool secureRandom(unsigned char* out, size_t size);
std::string websocketBearer(lws* wsi);
bool loopbackOrigin(const std::string& origin);
/** Whether the Host names this session: a loopback host, or the --public authority. */
bool localHost(const Config& config, lws* wsi);
/** Whether a request may come from its Origin header, if it sent one. */
bool allowedOrigin(const Config& config, lws* wsi);
bool loopbackHost(const std::string& host);
/** True for a lowercase https://HOST[:PORT] origin as a browser sends it: no path, wildcard, or default port. */
bool exactHttpsOrigin(const std::string& origin);
/** True for a lowercase http://localhost[:PORT] or http://127.0.0.1[:PORT] origin as a browser sends it, without port 80. */
bool exactLoopbackHttpOrigin(const std::string& origin);
/** True for an origin --allow-origin accepts: an exact HTTPS origin, or an exact loopback HTTP origin. */
bool exactAllowedOrigin(const std::string& origin);
/**
 * Decides a request that sent an Origin header. An allowlisted origin always passes; otherwise a session with a
 * public origin accepts only that origin, and a session without one accepts only loopback origins.
 */
bool originAllowed(const Config& config, const std::string& origin);
bool localRequest(const Config& config, lws* wsi);
}  // namespace relay
