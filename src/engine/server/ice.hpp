#pragma once

#include <string>

namespace relay {

/** Parsed STUN, TURN, or TURNS server entry shared by the engine and authenticated WebRTC viewers. */
struct IceServer {
  std::string url;
  std::string username;
  std::string credential;
  std::string raw;
};

}  // namespace relay
