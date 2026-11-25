#include "core/clipboard.hpp"
#include <memory>

namespace relay::android {

std::unique_ptr<ClipboardBackend> makeClipboard(ClipboardChanged /*changed*/) {
  return nullptr;
}

}  // namespace relay::android
