#include "config.hpp"
#include "backend.hpp"
#include <algorithm>
#include <charconv>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#else
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <cerrno>
#include <mach-o/dyld.h>
#include <membership.h>
#include <sys/acl.h>
#include <uuid/uuid.h>
#endif

namespace relay {
namespace {
#ifdef _WIN32
/// Reports whether an ACE only denies, audits, or labels access, so it cannot grant anyone access to the file.
bool deniesOrAudits(BYTE type) {
  switch (type) {
    case ACCESS_DENIED_ACE_TYPE: case ACCESS_DENIED_OBJECT_ACE_TYPE: case ACCESS_DENIED_CALLBACK_ACE_TYPE:
    case ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: case SYSTEM_AUDIT_ACE_TYPE: case SYSTEM_AUDIT_OBJECT_ACE_TYPE:
    case SYSTEM_AUDIT_CALLBACK_ACE_TYPE: case SYSTEM_AUDIT_CALLBACK_OBJECT_ACE_TYPE: case SYSTEM_ALARM_ACE_TYPE:
    case SYSTEM_MANDATORY_LABEL_ACE_TYPE:
      return true;
    default:
      return false;
  }
}
/// Reports whether only the current user, SYSTEM, and Administrators own or may open the file.
bool privateFile(const std::string& path, uintmax_t max_bytes) {
  std::error_code error;
  if (!std::filesystem::is_regular_file(path, error) || std::filesystem::file_size(path, error) > max_bytes || error) return false;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  alignas(TOKEN_USER) unsigned char buffer[256];
  DWORD length = 0;
  const bool queried = GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &length);
  CloseHandle(token);
  if (!queried) return false;
  const PSID user = reinterpret_cast<TOKEN_USER*>(buffer)->User.Sid;
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetNamedSecurityInfoA(path.c_str(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                            &owner, nullptr, &dacl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  const auto privileged = [&](PSID sid) {
    return EqualSid(sid, user) || IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
  };
  bool owned = dacl && owner && privileged(owner);
  for (DWORD index = 0; owned && index < dacl->AceCount; ++index) {
    ACE_HEADER* header = nullptr;
    if (!GetAce(dacl, index, reinterpret_cast<void**>(&header))) { owned = false; break; }
    if (deniesOrAudits(header->AceType)) continue;
    owned = header->AceType == ACCESS_ALLOWED_ACE_TYPE &&
            privileged(&reinterpret_cast<ACCESS_ALLOWED_ACE*>(header)->SidStart);
  }
  LocalFree(descriptor);
  return owned;
}
/// Path of the running engine binary, used to find the bundled viewer.
std::filesystem::path executablePath() {
  wchar_t path[MAX_PATH];
  const DWORD length = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (!length || length == MAX_PATH) throw std::runtime_error("Could not find the engine executable");
  return std::filesystem::path(path);
}
#elif defined(__APPLE__)
/// Path of the running engine binary, used to find the bundled viewer.
std::filesystem::path executablePath() {
  uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || !size) throw std::runtime_error("Could not find the engine executable");
  std::string path(size, '\0');
  if (_NSGetExecutablePath(path.data(), &size) != 0) throw std::runtime_error("Could not find the engine executable");
  return std::filesystem::canonical(path.c_str());
}
#else
/// Path of the running engine binary, used to find the bundled viewer.
std::filesystem::path executablePath() { return std::filesystem::canonical("/proc/self/exe"); }
#endif
#ifdef __APPLE__
/// Reports whether an extended ACL entry names only the user running the engine.
bool ownerAclEntry(acl_entry_t entry) {
  uuid_t owner;
  if (mbr_uid_to_uuid(geteuid(), owner)) return false;
  void* qualifier = acl_get_qualifier(entry);
  if (!qualifier) return false;
  const bool same = uuid_compare(*static_cast<uuid_t*>(qualifier), owner) == 0;
  acl_free(qualifier);
  return same;
}
/// Reports whether the file has no extended ACL entry that could grant another user access; deny entries and
/// allow entries for the owner are still accepted.
bool privateTokenAcl(const std::string& path) {
  acl_t acl = acl_get_file(path.c_str(), ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  while (result == 0) {
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag)) break;
    if (tag != ACL_EXTENDED_DENY && (tag != ACL_EXTENDED_ALLOW || !ownerAclEntry(entry))) break;
    result = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  const bool safe = result == -1 && errno == EINVAL;
  acl_free(acl);
  return safe;
}
#elif !defined(_WIN32)
/// Mode bits already reflect POSIX ACL grants, so there is nothing extra to check.
bool privateTokenAcl(const std::string&) { return true; }
#endif
#ifndef _WIN32
/// Reports whether the current user owns the file and no other user can read or write it.
bool privateFile(const std::string& path, uintmax_t max_bytes) {
  struct stat st{};
  return !stat(path.c_str(), &st) && S_ISREG(st.st_mode) && st.st_uid == geteuid() && !(st.st_mode & 0077) &&
         uintmax_t(st.st_size) <= max_bytes && privateTokenAcl(path);
}
#endif
bool privateTokenFile(const std::string& path) { return privateFile(path, 66); }
bool privateIceServersFile(const std::string& path) { return privateFile(path, 16384); }
}
bool secretEqual(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned difference = 0;
  for (size_t i = 0; i < a.size(); ++i) difference |= unsigned(a[i] ^ b[i]);
  return difference == 0;
}
std::string header(lws* wsi, lws_token_indexes token) {
  char value[1024];
  const int count = lws_hdr_copy(wsi, value, sizeof(value), token);
  return count > 0 ? std::string(value, size_t(count)) : "";
}
std::string websocketBearer(lws* wsi) {
  std::istringstream protocols(header(wsi, WSI_TOKEN_PROTOCOL));
  std::string protocol, bearer;
  while (std::getline(protocols, protocol, ',')) {
    const auto first = protocol.find_first_not_of(" \t");
    const auto last = protocol.find_last_not_of(" \t");
    if (first == std::string::npos) continue;
    protocol = protocol.substr(first, last-first+1);
    if (protocol.rfind("bearer.", 0) != 0) continue;
    if (!bearer.empty() || protocol.size() != 71) return {};
    bearer = protocol.substr(7);
  }
  return bearer;
}
bool authenticated(const Config& config, lws* wsi, bool websocket) {
  if (config.token.empty()) return true;
  if (websocket) return secretEqual(websocketBearer(wsi), config.token);
  return secretEqual(header(wsi, WSI_TOKEN_HTTP_AUTHORIZATION), "Bearer " + config.token);
}
bool secureRandom(unsigned char* out, size_t size) {
#ifdef _WIN32
  return BCRYPT_SUCCESS(BCryptGenRandom(nullptr, out, ULONG(size), BCRYPT_USE_SYSTEM_PREFERRED_RNG));
#else
  // getentropy fills at most 256 bytes per call.
  for (size_t done = 0; done < size; done += 256) {
    if (getentropy(out + done, std::min<size_t>(256, size - done)) != 0) return false;
  }
  return true;
#endif
}
uint64_t Grants::issue(std::string token, GrantScope scope, Clock::time_point now, uint64_t ttl, bool single) {
  grants.erase(std::remove_if(grants.begin(), grants.end(), [now](const auto& grant) { return now >= grant.expires; }), grants.end());
  if (grants.size() >= capacity || last_id == UINT64_MAX || !ttl || ttl > max_ttl || token.empty() || find(token, now)) return 0;
  const auto id = ++last_id;
  grants.push_back({id, std::move(token), scope, now + std::chrono::seconds(ttl), single});
  return id;
}
const Grants::Grant* Grants::find(const std::string& token, Clock::time_point now) const {
  if (token.empty()) return nullptr;
  for (const auto& grant : grants) {
    if (now < grant.expires && secretEqual(token, grant.token)) return grant.single && grant.claimed ? nullptr : &grant;
  }
  return nullptr;
}
bool Grants::claim(uint64_t id) {
  const auto entry = std::find_if(grants.begin(), grants.end(), [id](const auto& grant) { return grant.id == id; });
  if (entry == grants.end() || (entry->single && entry->claimed)) return false;
  entry->claimed = true;
  return true;
}
bool Grants::active(uint64_t id, Clock::time_point now) const {
  return std::any_of(grants.begin(), grants.end(), [id, now](const auto& grant) { return id == grant.id && now < grant.expires; });
}
bool Grants::revoke(uint64_t id) {
  const auto entry = std::find_if(grants.begin(), grants.end(), [id](const auto& grant) { return grant.id == id; });
  if (entry == grants.end()) return false;
  grants.erase(entry);
  return true;
}
bool loopbackOrigin(const std::string& origin) {
  const auto scheme = origin.find("://");
  if (scheme == std::string::npos || (origin.substr(0, scheme) != "http" && origin.substr(0, scheme) != "https")) return false;
  const auto host = origin.substr(scheme + 3);
  auto colon = host.find(':');
  const auto name = host.substr(0, colon);
  if (name != "localhost" && name != "127.0.0.1") return false;
  if (colon == std::string::npos) return true;
  const auto port = host.substr(colon + 1);
  if (port.empty() || port.size() > 5) return false;
  unsigned value = 0;
  for (char c : port) { if (c < '0' || c > '9') return false; value = value * 10 + unsigned(c - '0'); }
  return value > 0 && value <= 65535;
}
bool loopbackHost(const std::string& host) { return loopbackOrigin("http://" + host); }
bool exactHttpsOrigin(const std::string& origin) {
  if (origin.rfind("https://", 0) != 0) return false;
  const auto authority = origin.substr(8);
  const auto colon = authority.find(':');
  const auto name = authority.substr(0, colon);
  if (name.empty() || name.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789.-") != std::string::npos ||
      name.front() == '.' || name.front() == '-' || name.back() == '.' || name.back() == '-') return false;
  if (colon == std::string::npos) return true;
  const auto text = authority.substr(colon + 1);
  uint64_t port = 0;
  return text.size() <= 5 && unsignedNumber(text, port) && text.front() != '0' && port <= 65535 && port != 443;
}
bool exactLoopbackHttpOrigin(const std::string& origin) {
  if (origin.rfind("http://", 0) != 0) return false;
  const auto authority = origin.substr(7);
  const auto colon = authority.find(':');
  const auto name = authority.substr(0, colon);
  if (name != "localhost" && name != "127.0.0.1") return false;
  if (colon == std::string::npos) return true;
  const auto text = authority.substr(colon + 1);
  uint64_t port = 0;
  return text.size() <= 5 && unsignedNumber(text, port) && text.front() != '0' && port <= 65535 && port != 80;
}
bool exactAllowedOrigin(const std::string& origin) {
  return exactHttpsOrigin(origin) || exactLoopbackHttpOrigin(origin);
}
static std::string httpsAuthority(const std::string& authority) {
  if (authority.empty() || authority.find_first_of("/?#@\\ \t\r\n") != std::string::npos) return {};
  auto separator = authority.find(':');
  if (authority.front() == '[') {
    const auto bracket = authority.find(']');
    if (bracket == std::string::npos || bracket == 1) return {};
    separator = bracket + 1;
    if (separator == authority.size()) separator = std::string::npos;
    else if (authority[separator] != ':') return {};
  }
  auto host = authority.substr(0, separator);
  if (host.empty()) return {};
  for (auto& c : host) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  if (separator == std::string::npos) return host;
  uint64_t port = 0;
  if (!unsignedNumber(authority.substr(separator + 1), port) || !port || port > 65535) return {};
  return port == 443 ? host : host + ':' + std::to_string(port);
}
bool originAllowed(const Config& config, const std::string& origin) {
  if (std::find(config.allowed_origins.begin(), config.allowed_origins.end(), origin) != config.allowed_origins.end()) return true;
  return config.origin.empty() ? loopbackOrigin(origin) : origin == config.origin;
}
bool localHost(const Config& config, lws* wsi) {
  const auto host = header(wsi, WSI_TOKEN_HOST);
  return loopbackHost(host) || (!config.origin.empty() && httpsAuthority(host) == config.authority);
}
bool allowedOrigin(const Config& config, lws* wsi) {
  if (lws_hdr_total_length(wsi, WSI_TOKEN_ORIGIN) <= 0) return true;
  const auto host = header(wsi, WSI_TOKEN_HOST);
  const auto origin = header(wsi, WSI_TOKEN_ORIGIN);
  return originAllowed(config, origin) ||
         (loopbackHost(host) && loopbackOrigin(origin) && origin.substr(origin.find("://") + 3) == host);
}
bool localRequest(const Config& config, lws* wsi) { return localHost(config, wsi) && allowedOrigin(config, wsi); }
bool unsignedNumber(const std::string& text, uint64_t& value) {
  if (text.empty()) return false;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
  return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size();
}

namespace {
bool iceServerControl(unsigned char c) {
  return c <= 0x20 || c == 0x7f;
}

bool iceServerHostname(const std::string& host) {
  if (host.empty() || host.front() == '.' || host.back() == '.' || host.front() == '-' || host.back() == '-') return false;
  size_t start = 0;
  while (start < host.size()) {
    const auto dot = host.find('.', start);
    const auto end = dot == std::string::npos ? host.size() : dot;
    if (end == start) return false;
    if (host[start] == '-' || host[end - 1] == '-') return false;
    for (size_t index = start; index < end; ++index) {
      const unsigned char c = static_cast<unsigned char>(host[index]);
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-')) return false;
    }
    if (dot == std::string::npos) break;
    start = dot + 1;
  }
  return true;
}

bool iceServerIpv6(const std::string& host) {
  if (host.empty() || host.find(':') == std::string::npos) return false;
  if (host.front() == '.' || host.back() == '.' || host.find("..") != std::string::npos) return false;
  for (unsigned char c : host) {
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == ':' || c == '.') continue;
    return false;
  }
  return true;
}

bool iceServerPort(const std::string& text, uint64_t& port) {
  return text.size() <= 5 && !text.empty() && text.front() != '0' && unsignedNumber(text, port) && port > 0 && port <= 65535;
}

bool encoderName(const std::string& value) {
  return !value.empty() && value.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") == std::string::npos;
}
}

bool parseIceServer(const std::string& spec, IceServer& out) {
  if (spec.empty()) return false;
  for (unsigned char c : spec) if (iceServerControl(c)) return false;
  if (spec.find('#') != std::string::npos || spec.find('/') != std::string::npos) return false;
  const bool stun = spec.rfind("stun:", 0) == 0;
  const bool turn = spec.rfind("turn:", 0) == 0;
  const bool turns = spec.rfind("turns:", 0) == 0;
  if (!stun && !turn && !turns) return false;
  const std::string scheme = stun ? "stun:" : turn ? "turn:" : "turns:";
  std::string authority = spec.substr(scheme.size());
  if (authority.empty()) return false;
  IceServer parsed;
  parsed.raw = spec;
  if (!stun) {
    const auto at = authority.find('@');
    if (at != std::string::npos) {
      const std::string userinfo = authority.substr(0, at);
      const auto colon = userinfo.find(':');
      if (userinfo.empty() || colon == std::string::npos || colon == 0 || colon + 1 == userinfo.size() ||
          userinfo.find(':', colon + 1) != std::string::npos || userinfo.find_first_of("@?") != std::string::npos) return false;
      parsed.username = userinfo.substr(0, colon);
      parsed.credential = userinfo.substr(colon + 1);
      authority.erase(0, at + 1);
      if (authority.empty()) return false;
    }
  } else if (authority.find('@') != std::string::npos) {
    return false;
  }
  std::string query_suffix;
  const auto query = authority.find('?');
  if (query != std::string::npos) {
    if (stun) return false;
    query_suffix = authority.substr(query);
    if (query_suffix != "?transport=udp" && query_suffix != "?transport=tcp") return false;
    authority.erase(query);
  }
  if (authority.empty()) return false;
  std::string host;
  std::string port_text;
  if (authority.front() == '[') {
    const auto close = authority.find(']');
    if (close == std::string::npos || close == 1) return false;
    host = authority.substr(1, close - 1);
    if (!iceServerIpv6(host)) return false;
    if (close + 1 < authority.size()) {
      if (authority[close + 1] != ':') return false;
      port_text = authority.substr(close + 2);
      if (port_text.empty()) return false;
    }
  } else {
    const auto colon = authority.find(':');
    if (colon != std::string::npos) {
      if (authority.find(':', colon + 1) != std::string::npos) return false;
      host = authority.substr(0, colon);
      port_text = authority.substr(colon + 1);
      if (port_text.empty()) return false;
    } else {
      host = authority;
    }
    if (!iceServerHostname(host)) return false;
  }
  if (host.empty()) return false;
  if (!port_text.empty()) {
    uint64_t port = 0;
    if (!iceServerPort(port_text, port)) return false;
  }
  parsed.url = scheme + authority + query_suffix;
  out = std::move(parsed);
  return true;
}

bool parseConfig(int argc, char** argv, Config& config) {
  config.viewer = (executablePath().parent_path() / "viewer").string();
  if (config.backend.empty()) config.backend = defaultBackend().name;
  const auto bitrate = [](const std::string& text) {
    uint64_t value;
    if (!unsignedNumber(text, value) || value < 250000 || value > 100000000)
      throw std::runtime_error("Bitrate must be an integer from 250000 to 100000000 bits per second");
    return value;
  };
  for (int i = 1; i < argc; ++i) {
    const std::string option = argv[i];
    if (option == "--help") {
      std::cout << "Usage: relay-engine [--bind ADDRESS] [--port PORT] [--viewer-dir DIR]\n"
                   "  [--backend NAME] [--output NAME] [--encoder auto|x264|NAME] [--check]\n"
                   "  [--ice-server URL]... [--ice-servers-file FILE]\n"
                   "  [--fps N] [--bitrate-min BPS] [--bitrate-start BPS] [--bitrate-max BPS]\n"
                   "  [--token-file FILE [--public-origin https://HOST[:PORT]]\n"
                   "    [--allow-origin ORIGIN[,...]]]\n"
                   "  [--tls-cert FILE --tls-key FILE | --behind-tls-proxy]\n"
                   "  [--insecure-local: unauthenticated, isolated development network only]\n"
                   "FPS is 10 to 240; bitrates are 250000 to 100000000 bits per second with\n"
                   "min <= start <= max. Non-loopback --bind needs --token-file;\n"
                   "--public-origin also needs TLS or --behind-tls-proxy.\n"
                   "A browser request must come from the public origin, or from a loopback origin\n"
                   "when there is none, unless --allow-origin lists its exact origin. Each allowed\n"
                   "origin is a lowercase https://HOST[:PORT] origin, or http://localhost[:PORT] or\n"
                   "http://127.0.0.1[:PORT] for a page served on the machine itself.\n"
                   "--check initializes the backend and exits without starting capture or the server.\n"
                   "Attach to DISPLAY using the caller's XAUTHORITY. Defaults: 127.0.0.1:8080, 60 fps,\n"
                   "encoder auto, 1000000/8000000/40000000 bps.\n"
                   << "Compiled backends: " << backendNames() << '\n';
      return false;
    }
    if (option == "--behind-tls-proxy") { config.proxy = true; continue; }
    if (option == "--insecure-local") { config.insecure_local = true; continue; }
    if (option == "--check") { config.check = true; continue; }
    if (++i == argc) throw std::runtime_error("Missing value for " + option);
    const std::string value = argv[i];
    if (option == "--bind") config.bind = value;
    else if (option == "--backend") config.backend = value;
    else if (option == "--output") config.output = value;
    else if (option == "--encoder") {
      if (!encoderName(value)) throw std::runtime_error("Encoder must be auto, x264, or an alphanumeric/underscore name");
      config.encoder = value;
    } else if (option == "--ice-server") {
      if (config.ice_servers.size() == 8) throw std::runtime_error("At most 8 ICE servers");
      IceServer server;
      if (!parseIceServer(value, server)) throw std::runtime_error("Invalid ICE server");
      config.ice_servers.push_back(std::move(server));
    } else if (option == "--ice-servers-file") {
      if (!privateIceServersFile(value))
        throw std::runtime_error("ICE servers file must be private, owned by this user and at most 16 KiB");
      std::ifstream file(value);
      if (!file) throw std::runtime_error("Could not read ICE servers file");
      std::string line;
      while (std::getline(file, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const auto first = line.find_first_not_of(" \t");
        if (first == std::string::npos || line[first] == '#') continue;
        const auto last = line.find_last_not_of(" \t");
        const std::string entry = line.substr(first, last - first + 1);
        if (config.ice_servers.size() == 8) throw std::runtime_error("At most 8 ICE servers");
        IceServer server;
        if (!parseIceServer(entry, server)) throw std::runtime_error("Invalid ICE server");
        config.ice_servers.push_back(std::move(server));
      }
    } else if (option == "--port") {
      uint64_t port;
      if (!unsignedNumber(value, port) || !port || port > 65535) throw std::runtime_error("Invalid port");
      config.port = unsigned(port);
    } else if (option == "--fps") {
      uint64_t fps;
      if (!unsignedNumber(value, fps) || fps < 10 || fps > 240)
        throw std::runtime_error("FPS must be an integer from 10 to 240");
      config.fps = unsigned(fps);
    } else if (option == "--bitrate-min") config.bitrate_min = bitrate(value);
    else if (option == "--bitrate-start") config.bitrate_start = bitrate(value);
    else if (option == "--bitrate-max") config.bitrate_max = bitrate(value);
    else if (option == "--viewer-dir") config.viewer = value;
    else if (option == "--public-origin") {
      config.authority = value.rfind("https://", 0) == 0 ? httpsAuthority(value.substr(8)) : std::string{};
      if (config.authority.empty()) throw std::runtime_error("Public origin must be an HTTPS origin without path or credentials");
      config.origin = "https://" + config.authority;
    } else if (option == "--allow-origin") {
      std::istringstream origins(value + ',');
      std::string origin;
      while (std::getline(origins, origin, ',')) {
        if (!exactAllowedOrigin(origin) || config.allowed_origins.size() == 16)
          throw std::runtime_error("Allowed origins must be at most 16 comma-separated lowercase https://HOST[:PORT] origins, or http://localhost[:PORT] or http://127.0.0.1[:PORT] ones, without a path, wildcard or default port");
        config.allowed_origins.push_back(origin);
      }
    } else if (option == "--token-file") {
      if (!privateTokenFile(value))
        throw std::runtime_error("Token file must be private, owned by this user and contain 64 hexadecimal characters");
      std::ifstream file(value); std::getline(file, config.token);
      if (!file || config.token.size() != 64 || config.token.find_first_not_of("0123456789abcdef") != std::string::npos)
        throw std::runtime_error("Token must contain 64 lowercase hexadecimal characters");
    } else if (option == "--tls-cert") config.cert = value;
    else if (option == "--tls-key") config.key = value;
    else throw std::runtime_error("Unknown option: " + option);
  }
  backendFor(config.backend);
  if (config.cert.empty() != config.key.empty() || (config.proxy && !config.cert.empty()))
    throw std::runtime_error("Choose a TLS certificate/key pair or a TLS proxy");
  if (config.bitrate_min > config.bitrate_start || config.bitrate_start > config.bitrate_max)
    throw std::runtime_error("Bitrates must satisfy min <= start <= max");
  if (!config.origin.empty() && config.token.empty()) throw std::runtime_error("Public origin requires a token");
  if (!config.allowed_origins.empty() && config.token.empty()) throw std::runtime_error("Allowed origins require a token");
  if (config.insecure_local && (!config.token.empty() || !config.origin.empty() || !config.cert.empty() || config.proxy))
    throw std::runtime_error("--insecure-local cannot be combined with remote access options");
  if (config.bind != "127.0.0.1" && !config.insecure_local && (config.token.empty() || (!config.origin.empty() && config.cert.empty() && !config.proxy)))
    throw std::runtime_error("Non-loopback binding requires a token; a public origin also requires TLS or --behind-tls-proxy");
  if (config.insecure_local) std::cerr << "WARNING: unauthenticated development listener; isolate it and publish to host loopback only\n";
  if (!config.check) for (const char* name : {"index.html", "viewer.js"})
    if (!std::filesystem::is_regular_file(std::filesystem::path(config.viewer)/name)) throw std::runtime_error("Viewer assets missing; use --viewer-dir");
  return true;
}
}
