#include "server/backend.hpp"
#include "server/clipboard.hpp"
#include "server/config.hpp"
#include "server/metrics.hpp"
#include "server/rtc.hpp"
#include "server/wire.hpp"
#include <libwebsockets.h>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <condition_variable>
#include <mutex>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#ifndef _WIN32
#include <sys/stat.h>
#else
#include <windows.h>
#include <aclapi.h>
#endif

#ifdef _WIN32
static bool setPrivateWindowsAcl(const std::string& path) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  alignas(TOKEN_USER) unsigned char buffer[256];
  DWORD length = 0;
  const bool queried = GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &length);
  CloseHandle(token);
  if (!queried) return false;
  EXPLICIT_ACCESS_A ea{};
  ea.grfAccessPermissions = FILE_ALL_ACCESS;
  ea.grfAccessMode = SET_ACCESS;
  ea.grfInheritance = NO_INHERITANCE;
  ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  ea.Trustee.TrusteeType = TRUSTEE_IS_USER;
  ea.Trustee.ptstrName = static_cast<LPSTR>(reinterpret_cast<TOKEN_USER*>(buffer)->User.Sid);
  PACL dacl = nullptr;
  if (SetEntriesInAclA(1, &ea, nullptr, &dacl) != ERROR_SUCCESS) return false;
  std::string mutable_path = path;
  const DWORD rc = SetNamedSecurityInfoA(mutable_path.data(), SE_FILE_OBJECT,
                                         DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                                         nullptr, nullptr, dacl, nullptr);
  LocalFree(dacl);
  return rc == ERROR_SUCCESS;
}
#endif

static bool engineConfig(const std::vector<std::string>& options, relay::Config& config, std::string* error = nullptr) {
  relay::Config parsed;
  std::vector<std::string> values = {"relay-engine", "--viewer-dir", "build/test-viewer"};
  values.insert(values.end(), options.begin(), options.end());
  std::vector<char*> argv;
  for (auto& value : values) argv.push_back(value.data());
  try {
    if (!relay::parseConfig(int(argv.size()), argv.data(), parsed)) return false;
  } catch (const std::runtime_error& exception) {
    if (error) *error = exception.what();
    return false;
  }
  config = std::move(parsed);
  return true;
}

int main() {
  using namespace relay;
  uint64_t parsed = 0;
  assert(statValue("usage_usec 12345\nuser_usec 9\n", "usage_usec", parsed) && parsed == 12345);
  assert(!statValue("usage_usec 12x\n", "usage_usec", parsed));
  assert(!statValue("usage_usec 1\nusage_usec 2\n", "usage_usec", parsed));
  assert(!unsignedNumber("18446744073709551616", parsed));
  uint8_t b[8] = {}; put(b, 0x12345678, 4); assert(u32(b) == 0x12345678);
  put(b, 0xabcd, 2); assert(u16(b) == 0xabcd);
  assert(loopbackOrigin("http://127.0.0.1:8080") && loopbackOrigin("https://localhost"));
  assert(!loopbackOrigin("http://localhost.evil:8080") && !loopbackOrigin("http://localhost:0"));
  assert(!loopbackOrigin("http://localhost:8080/path") && !loopbackOrigin("null"));
  assert(loopbackHost("localhost:8080") && loopbackHost("127.0.0.1:19110"));
  assert(!loopbackHost("localhost.evil:8080") && !loopbackHost("user@localhost") && !loopbackHost("localhost:0"));
  assert(exactHttpsOrigin("https://app.example.com") && exactHttpsOrigin("https://app.example.com:8443"));
  for (const char* origin : {"*", "null", "", "https://", "https://*.example.com", "http://app.example.com", "https://App.example.com",
                             "https://app.example.com/", "https://app.example.com:443", "https://app.example.com:08443",
                             "https://app.example.com:65536", "https://app.example.com:", "https://user@app.example.com",
                             "https://.example.com", "https://app.example.com.", "https://[::1]", " https://app.example.com"}) {
    assert(!exactHttpsOrigin(origin));
  }
  assert(exactLoopbackHttpOrigin("http://localhost:8081") && exactLoopbackHttpOrigin("http://127.0.0.1:3000"));
  assert(exactLoopbackHttpOrigin("http://localhost") && exactLoopbackHttpOrigin("http://127.0.0.1"));
  for (const char* origin : {"http://app.example.com", "http://app.example.com:8081", "http://LOCALHOST:8081",
                             "http://localhost.evil:8081", "http://localhost:8081/", "http://localhost:80",
                             "http://127.0.0.1:80", "http://localhost:08081", "http://localhost:65536",
                             "http://localhost:", "https://localhost:8081", "http://[::1]:8081"}) {
    assert(!exactLoopbackHttpOrigin(origin));
  }
  assert(exactAllowedOrigin("https://app.example.com") && exactAllowedOrigin("http://localhost:8081"));
  assert(!exactAllowedOrigin("http://app.example.com") && !exactAllowedOrigin("*") && !exactAllowedOrigin("null"));
  {
    Config local;
    assert(originAllowed(local, "http://127.0.0.1:8080") && originAllowed(local, "http://localhost:3000"));
    assert(!originAllowed(local, "https://app.example.com") && !originAllowed(local, "null") && !originAllowed(local, "") &&
           !originAllowed(local, "*") && !originAllowed(local, "http://localhost.evil:8080"));
    local.allowed_origins = {"https://app.example.com"};
    assert(originAllowed(local, "https://app.example.com") && originAllowed(local, "http://localhost:8080"));
    assert(!originAllowed(local, "https://app.example.com:8443") && !originAllowed(local, "https://sub.app.example.com") &&
           !originAllowed(local, "https://app.example.com.evil.test") && !originAllowed(local, "http://app.example.com") &&
           !originAllowed(local, "https://APP.example.com") && !originAllowed(local, "null"));
    Config remote;
    remote.origin = "https://desk.example.com"; remote.authority = "desk.example.com";
    assert(originAllowed(remote, "https://desk.example.com"));
    assert(!originAllowed(remote, "http://localhost:8080") && !originAllowed(remote, "http://127.0.0.1:8080") &&
           !originAllowed(remote, "https://desk.example.com:8443") && !originAllowed(remote, "http://desk.example.com") &&
           !originAllowed(remote, "https://app.example.com") && !originAllowed(remote, "null") && !originAllowed(remote, ""));
    remote.allowed_origins = {"https://app.example.com", "https://host.example.net:8443", "http://localhost:8081"};
    assert(originAllowed(remote, "https://app.example.com") && originAllowed(remote, "https://host.example.net:8443") &&
           originAllowed(remote, "http://localhost:8081") && originAllowed(remote, "https://desk.example.com"));
    assert(!originAllowed(remote, "https://host.example.net") && !originAllowed(remote, "http://localhost:8080") &&
           !originAllowed(remote, "http://localhost:8082") && !originAllowed(remote, "http://127.0.0.1:8081"));
  }
  {
    Config config;
    std::string error;
    for (const char* value : {"", "*", "null", "https://*.example.com", "http://app.example.com", "https://app.example.com/",
                              "https://app.example.com,", ",https://app.example.com", "https://a.example.com,,https://b.example.com",
                              "https://a.example.com, https://b.example.com", "http://localhost:80", "http://localhost:8081/",
                              "http://LOCALHOST:8081", "http://localhost.evil:8081"}) {
      error.clear();
      assert(!engineConfig({"--allow-origin", value}, config, &error) && error.rfind("Allowed origins must be", 0) == 0);
    }
    std::string many = "https://h0.example.com";
    for (int index = 1; index <= 16; ++index) many += ",https://h" + std::to_string(index) + ".example.com";
    error.clear();
    assert(!engineConfig({"--allow-origin", many}, config, &error) && error.rfind("Allowed origins must be", 0) == 0);
    error.clear();
    assert(!engineConfig({"--allow-origin", "https://a.example.com,https://b.example.com:8443"}, config, &error) &&
           error == "Allowed origins require a token");
#ifndef _WIN32
    const std::string tokenFile = "build/server-test-token";
    std::remove(tokenFile.c_str());
    { std::ofstream file(tokenFile); file << std::string(64, 'a') << '\n'; }
    assert(!chmod(tokenFile.c_str(), 0600));
    assert(engineConfig({"--token-file", tokenFile, "--allow-origin", "https://a.example.com,https://b.example.com:8443"}, config));
    assert((config.allowed_origins == std::vector<std::string>{"https://a.example.com", "https://b.example.com:8443"}));
    assert(engineConfig({"--token-file", tokenFile, "--allow-origin", "https://a.example.com,http://localhost:8081"}, config));
    assert((config.allowed_origins == std::vector<std::string>{"https://a.example.com", "http://localhost:8081"}));
    error.clear();
    assert(!engineConfig({"--token-file", tokenFile, "--allow-origin", "http://app.example.com,http://localhost:8081"}, config, &error) &&
           error.rfind("Allowed origins must be", 0) == 0);
    for (const auto& [input, expected] : std::vector<std::pair<const char*, const char*>>{
           {"https://DESK.Example.com:443", "desk.example.com"},
           {"https://DESK.Example.com:08443", "desk.example.com:8443"},
           {"https://[2001:DB8::1]:443", "[2001:db8::1]"}}) {
      assert(engineConfig({"--token-file", tokenFile, "--public-origin", input, "--behind-tls-proxy"}, config));
      assert(config.authority == expected);
      assert(originAllowed(config, "https://" + config.authority));
    }
    std::remove(tokenFile.c_str());
#endif
  }
  uint8_t event[16] = {6, 0, 0, 1, 0xff, 0xff, 0xff, 0x88};
  event[13] = 16; event[15] = 128;
  const auto input = inputEvent(event);
  assert(input.type == 6 && input.code == 1 && input.value == -120 && input.buttons == 16 && input.modifiers == 128);
  uint64_t length = 0;
  assert(inputLength("", length) == HTTP_STATUS_LENGTH_REQUIRED && inputLength("0", length) == HTTP_STATUS_BAD_REQUEST);
  assert(inputLength("17", length) == HTTP_STATUS_BAD_REQUEST && inputLength("-16", length) == HTTP_STATUS_BAD_REQUEST);
  assert(!inputLength("4096", length) && length == 4096 && inputLength("4112", length) == HTTP_STATUS_REQ_ENTITY_TOO_LARGE);
  {
    Grants grants;
    const auto start = Grants::Clock::now();
    const auto watch = grants.issue("watch", GrantScope::watch, start, 1);
    const auto control = grants.issue("control", GrantScope::control, start, 2);
    assert(watch && control && watch != control);
    assert(grants.find("watch", start)->scope == GrantScope::watch);
    assert(grants.find("control", start)->scope == GrantScope::control);
    assert(!grants.find("missing", start));
    assert(!grants.active(watch, start + std::chrono::seconds(1)));
    assert(!grants.find("watch", start + std::chrono::seconds(1)));
    assert(grants.revoke(control) && !grants.active(control, start));
    for (size_t i = 0; i < Grants::capacity; ++i) {
      assert(grants.issue(std::to_string(i), GrantScope::watch, start + std::chrono::seconds(2), 1));
    }
    assert(!grants.issue("full", GrantScope::watch, start + std::chrono::seconds(2), 1));
    assert(grants.find("0", start + std::chrono::seconds(2)));
  }
  {
    Grants grants;
    const auto start = Grants::Clock::now();
    const auto once = grants.issue("once", GrantScope::control, start, 60, true);
    assert(grants.find("once", start) && grants.available("once", start));
    assert(grants.reserve(once));
    assert(grants.find("once", start) && !grants.available("once", start));
    assert(!grants.reserve(once) && !grants.claim(once));
    grants.release(once);
    assert(grants.find("once", start) && grants.available("once", start));
    assert(grants.claim(once));
    assert(grants.find("once", start) && !grants.available("once", start));
    assert(!grants.claim(once) && !grants.reserve(once));
    assert(grants.active(once, start));
    assert(grants.revoke(once) && !grants.active(once, start) && !grants.claim(once) && !grants.find("once", start));
  }
  {
    Grants grants;
    const auto start = Grants::Clock::now();
    const auto once = grants.issue("once", GrantScope::control, start, 60, true);
    assert(grants.reserve(once));
    grants.commit(once);
    assert(grants.find("once", start)->use == Grants::Use::used);
    assert(grants.find("once", start) && !grants.available("once", start));
    grants.release(once);
    assert(grants.find("once", start) && !grants.available("once", start));
    assert(!grants.claim(once) && !grants.reserve(once));
    assert(grants.revoke(once) && !grants.active(once, start) && !grants.find("once", start));
  }
  {
    Grants grants;
    const auto start = Grants::Clock::now();
    const auto many = grants.issue("many", GrantScope::control, start, 60);
    assert(grants.available("many", start));
    assert(grants.reserve(many) && grants.available("many", start));
    grants.commit(many);
    assert(grants.available("many", start));
    grants.release(many);
    assert(grants.available("many", start));
    assert(grants.claim(many) && grants.claim(many) && grants.find("many", start) && grants.available("many", start));
  }
  {
    Grants grants;
    const auto start = Grants::Clock::now();
    const auto once = grants.issue("once", GrantScope::control, start, 60, true);
    assert(grants.claim(once));
    assert(!grants.issue("once", GrantScope::control, start, 60, true));
  }
  {
    unsigned char first[300] = {}, second[300] = {};
    assert(secureRandom(first, sizeof(first)) && secureRandom(second, sizeof(second)));
    assert(std::memcmp(first, second, sizeof(first)) != 0);
    // The tail past getentropy's 256-byte limit is filled too.
    const unsigned char zero[44] = {};
    assert(std::memcmp(first + 256, zero, sizeof(zero)) != 0);
  }
  const auto target = [](const char* text, Socket socket, bool clipboard) {
    const auto parsed = viewerTarget(text);
    return parsed.socket == socket && parsed.clipboard == clipboard;
  };
  assert(target("/stream?view=1", Socket::watch, false) && target("/stream", Socket::stream, false));
  assert(target("/stream?clipboard=1", Socket::stream, true) && target("/stream?take=1", Socket::take, false));
  assert(target("/stream?take=1&clipboard=1", Socket::take, true) && target("/control", Socket::control, false));
  for (const char* text : {"/", "/stream?view=0", "/stream?view=1&x=2", "/control?view=1", "/stream?control=1",
                           "/stream?take=0", "/control?take=1", "/stream?view=1&take=1", "/stream?clipboard=0",
                           "/stream?view=1&clipboard=1", "/control?clipboard=1", "/stream?clipboard=1&take=1"}) {
    assert(target(text, Socket::none, false));
  }
  {
    struct Row { Socket socket; size_t viewerCount; bool owns, control, open, closeStream, closeControl; };
    const Row rows[] = {
      {Socket::watch, 0, false, false, true, false, false},
      {Socket::watch, 1, true, false, true, false, false},
      {Socket::watch, 1, false, true, true, false, false},
      {Socket::watch, max_viewers, true, false, false, false, false},
      {Socket::stream, 0, false, false, true, false, false},
      {Socket::stream, 1, false, false, true, false, false},
      {Socket::stream, 1, true, false, false, false, false},
      {Socket::stream, 0, false, true, false, false, false},
      {Socket::stream, max_viewers, false, false, false, false, false},
      {Socket::control, max_viewers, false, false, true, false, false},
      {Socket::control, 1, true, false, false, false, false},
      {Socket::control, 0, false, true, false, false, false},
      {Socket::take, 1, true, false, true, true, false},
      {Socket::take, 1, false, true, true, false, true},
      {Socket::take, max_viewers, true, false, true, true, false},
      {Socket::take, max_viewers, false, true, false, false, false},
      {Socket::none, 0, false, false, false, false, false},
    };
    for (const auto& row : rows) {
      const auto plan = connectionPlan(row.socket, row.viewerCount, row.owns, row.control, 0, false, false);
      assert(plan.open == row.open && plan.closeStream == row.closeStream && plan.closeControl == row.closeControl);
    }
    const auto grantLimit = max_viewers - 1;
    assert(!connectionPlan(Socket::watch, grantLimit, false, false, grantLimit, true, false).open);
    assert(connectionPlan(Socket::watch, grantLimit, false, false, grantLimit, false, false).open);
    assert(connectionPlan(Socket::watch, max_viewers - 1, false, false, grantLimit - 1, true, false).open);
    assert(!connectionPlan(Socket::watch, max_viewers, false, false, grantLimit - 1, true, false).open);
    assert(!connectionPlan(Socket::take, max_viewers, true, false, grantLimit, true, false).open);
    const auto replacement = connectionPlan(Socket::take, grantLimit, true, false, grantLimit, true, true);
    assert(replacement.open && replacement.closeStream);
    assert(!connectionPlan(Socket::take, max_viewers, true, false, max_viewers, true, true).open);
    assert(!connectionPlan(Socket::take, max_viewers + 1, true, false, grantLimit, false, true).open);
    assert(connectionPlan(Socket::take, max_viewers, true, false, grantLimit, false, true).open);
    assert(connectionPlan(Socket::control, grantLimit, false, false, grantLimit, true, false).open);
  }
  assert(clipboardLength("", length) == HTTP_STATUS_LENGTH_REQUIRED && clipboardLength("x", length) == HTTP_STATUS_BAD_REQUEST);
  assert(!clipboardLength("0", length) && length == 0);
  assert(!clipboardLength("262144", length) && clipboardLength("262145", length) == HTTP_STATUS_REQ_ENTITY_TOO_LARGE);
  assert(validText("") && validText("caf\xc3\xa9 \xe2\x9c\x93 \xf0\x9f\x9a\x80\n"));
  for (const std::string& bad : {std::string("a\0b", 3), std::string("\xff"), std::string("\xc0\xaf"), std::string("\xed\xa0\x80"),
                                 std::string("\xf4\x90\x80\x80"), std::string("\xe2\x9c")}) {
    assert(!validText(bad));
  }
  assert(jsonString("a\"b\\c\n\t\r\x01\xe2\x9c\x93") == "\"a\\\"b\\\\c\\n\\t\\r\\u0001\xe2\x9c\x93\"");
  assert(jsonString("x\xffy\xe2\x9c") == "\"x\\ufffdy\\ufffd\\ufffd\"");
  {
    std::vector<uint8_t> notice;
    clipboardNotice(notice, 1, 9);
    const uint8_t expected[] = {0, 'N', 'S', 'L', '1', 1, 7, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0};
    assert(notice == std::vector<uint8_t>(expected, expected + sizeof(expected)));
  }
  {
    struct Fake final : ClipboardBackend {
      std::string text = "first";
      std::optional<std::string> read() override { return text; }
      bool write(const std::string& value) override { text = value; return true; }
    };
    std::mutex mutex;
    std::condition_variable woke;
    size_t wakes = 0;
    ClipboardWorker worker;
    assert(!worker.available() && !worker.submit(nullptr, std::nullopt));
    worker.start(std::make_unique<Fake>(), [&] { std::lock_guard<std::mutex> lock(mutex); ++wakes; woke.notify_all(); });
    auto* a = reinterpret_cast<lws*>(1);
    auto* b = reinterpret_cast<lws*>(2);
    assert(worker.submit(a, std::string("second")) && worker.submit(b, std::nullopt));
    { std::unique_lock<std::mutex> lock(mutex); woke.wait(lock, [&] { return wakes == 2; }); }
    const auto replies = worker.take();
    assert(replies.size() == 2 && replies[0].client == a && replies[0].status == 200 && replies[0].body == "{\"length\":6}");
    assert(replies[1].client == b && replies[1].body == "{\"text\":\"second\"}");
    assert(worker.submit(a, std::nullopt));
    { std::unique_lock<std::mutex> lock(mutex); woke.wait(lock, [&] { return wakes == 3; }); }
    worker.forget(a);
    assert(worker.take().empty());
    worker.stop();
    assert(!worker.submit(a, std::nullopt));
  }
  assert(clipboardReply(std::nullopt, true, false).status == 503 && clipboardReply(std::string("x"), false, false).status == 503);
  assert(clipboardReply(std::string(max_clipboard_bytes + 1, 'a'), true, true).status == 413);
  std::vector<uint8_t> out;
  controlReady(out, 2, 7, 1280, 720);
  const uint8_t ready[] = {0, 0, 'N', 'S', 'L', '1', 1, 4, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 4, 5, 0, 2, 208};
  assert(out == std::vector<uint8_t>(ready, ready + sizeof(ready)));
  Config engine;
  const std::string defaultName = defaultBackend().name;
  assert(engineConfig({}, engine) && engine.backend == defaultName && engine.fps == 60 &&
         engine.bitrate_min == 1000000 && engine.bitrate_start == 8000000 && engine.bitrate_max == 40000000 &&
         engine.encoder == "auto");
  assert(engineConfig({"--backend", defaultName, "--output", "HDMI-A-1"}, engine) &&
         engine.backend == defaultName && engine.output == "HDMI-A-1");
  assert(engineConfig({"--check", "--viewer-dir", "build/missing-viewer"}, engine) && engine.check);
  std::string error;
  assert(!engineConfig({"--backend", "wayland2"}, engine, &error));
  assert(error.find("wayland2") != std::string::npos && error.find(backendNames()) != std::string::npos);
  assert(!engineConfig({"--output"}, engine, &error));
  assert(error == "Missing value for --output");
  assert(engineConfig({"--fps", "10"}, engine) && engine.fps == 10);
  assert(engineConfig({"--fps", "60"}, engine) && engine.fps == 60);
  assert(engineConfig({"--fps", "120"}, engine) && engine.fps == 120);
  assert(engineConfig({"--fps", "240"}, engine) && engine.fps == 240);
  assert(!engineConfig({"--fps", "9"}, engine) && !engineConfig({"--fps", "241"}, engine));
  assert(!engineConfig({"--fps", "-1"}, engine) && !engineConfig({"--fps", "30x"}, engine));
  assert(engineConfig({"--bitrate-min", "250000", "--bitrate-start", "250000", "--bitrate-max", "100000000"}, engine));
  assert(engine.bitrate_min == 250000 && engine.bitrate_start == 250000 && engine.bitrate_max == 100000000);
  assert(engineConfig({"--bitrate-start", "15000000", "--bitrate-max", "20000000"}, engine));
  assert(!engineConfig({"--bitrate-min", "249999"}, engine));
  assert(!engineConfig({"--bitrate-max", "100000001"}, engine));
  assert(!engineConfig({"--bitrate-min", "9000000"}, engine));
  assert(!engineConfig({"--bitrate-start", "40000001"}, engine));
  assert(engineConfig({"--encoder", "x264"}, engine) && engine.encoder == "x264");
  assert(engineConfig({"--encoder", "nvenc_1"}, engine) && engine.encoder == "nvenc_1");
  for (const std::string value : {"", "x264-hw", "x264 hw", "x264/hw", "x264#hw"}) {
    error.clear();
    assert(!engineConfig({"--encoder", value}, engine, &error));
  }
  {
    IceServer server;
    assert(parseIceServer("stun:stun.example.com", server) && server.raw == "stun:stun.example.com" && server.url == "stun:stun.example.com" &&
           server.username.empty() && server.credential.empty());
    assert(parseIceServer("stun:[2001:db8::1]:3478", server) && server.url == "stun:[2001:db8::1]:3478");
    assert(parseIceServer("turn:relay.example.com:3478?transport=udp", server) && server.url == "turn:relay.example.com:3478?transport=udp");
    assert(parseIceServer("turn:user:pass@relay.example.com:3478?transport=tcp", server) &&
           server.url == "turn:relay.example.com:3478?transport=tcp" && server.username == "user" && server.credential == "pass");
    assert(parseIceServer("turns:alice:secret@[2001:db8::1]:5349?transport=tcp", server) &&
           server.url == "turns:[2001:db8::1]:5349?transport=tcp" && server.username == "alice" && server.credential == "secret");
    for (const std::string spec : {"", "TURN:relay.example.com", "turn:user@relay.example.com", "turn::pass@relay.example.com",
                                   "turn:user:pass@relay.example.com:0", "turn:user:pass@relay.example.com:65536",
                                   "turn:user:pass@relay.example.com:080", "stun:user:pass@relay.example.com",
                                   "turn:relay.example.com?transport=icmp", "turn:relay.example.com?transport=tcp&foo=bar",
                                   "stun:relay.example.com?transport=udp", "turn:relay.example.com/path",
                                   "turn:relay.example.com#frag", " turn:relay.example.com ",
                                   "turn:user:pass@relay.example.com:3478?transport=tcp ",
                                   "stun:[dead.beef]:3478", "stun:[1..2]:3478"}) {
      IceServer invalid;
      assert(!parseIceServer(spec, invalid));
    }
  }
  {
    Config ice;
    std::string error;
    assert(engineConfig({"--ice-server", "stun:stun.example.com", "--ice-server", "turn:user:pass@relay.example.com:3478?transport=tcp"}, ice, &error));
    assert(ice.ice_servers.size() == 2);
    assert(ice.ice_servers[0].url == "stun:stun.example.com");
    assert(ice.ice_servers[1].url == "turn:relay.example.com:3478?transport=tcp");
    assert(ice.ice_servers[1].username == "user" && ice.ice_servers[1].credential == "pass");
    std::vector<std::string> many_ice_servers;
    for (int index = 0; index < 8; ++index) {
      many_ice_servers.push_back("--ice-server");
      many_ice_servers.push_back("stun:stun" + std::to_string(index) + ".example.com");
    }
    assert(engineConfig(many_ice_servers, ice, &error) && ice.ice_servers.size() == 8);
    many_ice_servers.push_back("--ice-server");
    many_ice_servers.push_back("stun:overflow.example.com");
    error.clear();
    assert(!engineConfig(many_ice_servers, ice, &error));
  }
  {
    const auto ice_file = std::filesystem::path("build/test-ice-servers.txt");
    {
      std::ofstream out(ice_file);
      out << "# comment\n\nstun:stun.example.com\nturn:alice:secret@turn.example.com:3478?transport=tcp\n";
    }
#ifdef _WIN32
    assert(setPrivateWindowsAcl(ice_file.string()));
#else
    chmod(ice_file.c_str(), 0644);
    Config bad_mode;
    std::string mode_error;
    assert(!engineConfig({"--ice-servers-file", ice_file.string()}, bad_mode, &mode_error));
    chmod(ice_file.c_str(), 0600);
#endif
    Config from_file;
    assert(engineConfig({"--ice-servers-file", ice_file.string()}, from_file));
    assert(from_file.ice_servers.size() == 2);
    assert(from_file.ice_servers[0].url == "stun:stun.example.com");
    assert(from_file.ice_servers[1].url == "turn:turn.example.com:3478?transport=tcp");
    assert(from_file.ice_servers[1].username == "alice" && from_file.ice_servers[1].credential == "secret");
    std::filesystem::remove(ice_file);
  }
  {
    assert(rtcSessionAuthorized(true, 0, 0));
    assert(rtcSessionAuthorized(true, 0, 7));
    assert(rtcSessionAuthorized(false, 7, 7));
    assert(!rtcSessionAuthorized(false, 7, 0));
    assert(!rtcSessionAuthorized(false, 7, 8));
    assert(!rtcSessionAuthorized(false, 0, 0));

    assert(rtcAdmission(0, 0, 0, 0, 7, false).allowed);
    assert(rtcAdmission(2, 1, 1, 1, 7, false).allowed);
    assert(!rtcAdmission(2, 2, 1, 1, 7, false).allowed);
    assert(!rtcAdmission(2, 1, 2, 1, 7, false).allowed);
    assert(rtcAdmission(2, 2, 1, 1, 0, false).allowed);
    const auto takeover = rtcAdmission(2, 1, 2, 1, 0, false);
    assert(takeover.allowed && takeover.replace);
    const auto grant_replacement = rtcAdmission(2, 2, 1, 1, 7, true);
    assert(grant_replacement.allowed && grant_replacement.replace);
    assert(!rtcAdmission(3, 1, 2, 1, 0, false).allowed);
    assert(!connectionPlan(Socket::take, 1, true, false, 0, true, false).open);

  }
  {
    RtcAnswerGate gate;
    std::string answer, error;
    assert(!gate.settled() && !gate.take(answer, error));
  }
  {
    RtcAnswerGate gate;
    assert(gate.begin() && gate.state() == RtcAnswerState::pending && !gate.begin());
  }
  {
    RtcAnswerGate gate;
    std::string answer, error;
    assert(gate.begin());
    gate.reject("rtc_failed");
    gate.resolve("sdp");
    assert(gate.state() == RtcAnswerState::failed && gate.take(answer, error) && error == "rtc_failed" && answer.empty());
  }
  {
    RtcAnswerGate gate;
    std::string answer, error;
    assert(gate.begin());
    gate.resolve("v=0");
    gate.reject("rtc_closed");
    assert(gate.state() == RtcAnswerState::answered && gate.take(answer, error) && answer == "v=0" && error.empty());
  }
  {
    RtcAnswerGate gate;
    std::string answer, error;
    assert(gate.begin());
    gate.reject("");
    assert(gate.state() == RtcAnswerState::failed && gate.take(answer, error) && error == "rtc_failed" && answer.empty());
  }
  {
    assert(classifyRtcOffer(false, false, false) == RtcOfferOutcome::waiting);
    assert(classifyRtcOffer(true, true, false) == RtcOfferOutcome::answered);
    assert(classifyRtcOffer(true, false, false) == RtcOfferOutcome::failed);
    assert(classifyRtcOffer(false, false, true) == RtcOfferOutcome::failed);
    assert(rtcOfferErrorStatus("no_h264") == HTTP_STATUS_BAD_REQUEST);
    assert(rtcOfferErrorStatus("invalid_offer") == HTTP_STATUS_BAD_REQUEST);
    assert(rtcOfferErrorStatus("rtc_failed") == HTTP_STATUS_SERVICE_UNAVAILABLE);
    assert(rtcOfferErrorStatus("no_answer") == HTTP_STATUS_SERVICE_UNAVAILABLE);
    assert(rtcOfferErrorStatus("rtc_timeout") == HTTP_STATUS_SERVICE_UNAVAILABLE);
  }
#ifndef RELAY_RTC
  {
    std::mutex mutex;
    std::condition_variable ready;
    bool woke = false;
    RtcCallbacks callbacks;
    callbacks.wake = [&] {
      std::lock_guard<std::mutex> lock(mutex);
      woke = true;
      ready.notify_one();
    };
    RtcSession session({}, true, false, std::move(callbacks));
    assert(session.state() == RtcState::idle && !session.closed());
    session.startOffer("offer");
    {
      std::unique_lock<std::mutex> lock(mutex);
      assert(ready.wait_for(lock, std::chrono::seconds(2), [&] { return woke; }));
    }
    std::string answer, error;
    assert(session.takeAnswer(answer, error) && answer.empty() && error == "rtc_disabled");
    assert(session.closed() && !session.canSendInput() && !session.canReceiveClipboard());
    assert(session.takeInput().empty() && session.takeAcks().empty());
    session.close();
  }
#endif
  return 0;
}
