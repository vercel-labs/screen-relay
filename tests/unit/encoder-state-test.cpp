#include "core/encoder.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::vector<uint8_t> validIdr() {
  return {
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x20,
      0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
      0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21,
  };
}

std::vector<uint8_t> validDelta() {
  return {0, 0, 0, 1, 0x41, 0x9a, 0x11, 0x22};
}

/** Deterministic fake VideoEncoder scripting exact outcomes to verify every EncoderController transition. */
class ScriptedEncoder final : public relay::VideoEncoder {
 public:
  struct Step {
    relay::EncodeStatus status = relay::EncodeStatus::encoded;
    bool keyframe = false;
    std::vector<uint8_t> annex_b;
    std::string error;
    bool submit_fail = false;
  };

  ScriptedEncoder(std::string name, bool hw, std::deque<Step> steps, bool allow_reset = true)
      : name_(std::move(name)), hw_(hw), steps_(std::move(steps)), allow_reset_(allow_reset),
        y_(640 * 360, 16), uv_(640 * 180, 128) {}

  const std::string& name() const override { return name_; }
  bool hardware() const override { return hw_; }
  relay::EncoderInput inputFormat() const override { return relay::EncoderInput::nv12; }

  relay::EncoderPlanes planes() override {
    return {{y_.data(), uv_.data()}, {640, 640}};
  }

  bool submit(const relay::EncodeRequest& req, std::string& error) override {
    Step step;
    if (!steps_.empty()) {
      step = std::move(steps_.front());
      steps_.pop_front();
    } else {
      step.status = relay::EncodeStatus::encoded;
      step.keyframe = req.force_idr;
      step.annex_b = req.force_idr ? validIdr() : validDelta();
    }
    if (step.submit_fail) {
      error = step.error.empty() ? "scripted submit failure" : step.error;
      return false;
    }
    relay::EncodeResult res;
    res.status = step.status;
    res.pts_us = req.pts_us;
    res.tag = req.tag;
    res.keyframe = step.keyframe;
    res.annex_b = std::move(step.annex_b);
    res.error = std::move(step.error);
    ready_.push_back(std::move(res));
    return true;
  }

  bool poll(std::vector<relay::EncodeResult>& out, bool) override {
    if (ready_.empty()) return false;
    while (!ready_.empty()) {
      out.push_back(std::move(ready_.front()));
      ready_.pop_front();
    }
    return true;
  }

  void flush(std::vector<relay::EncodeResult>& out) override { poll(out, false); }

  bool reset(std::string& error) override {
    ++resets;
    if (!allow_reset_) {
      error = "reset rejected";
      return false;
    }
    return true;
  }

  unsigned resets = 0;

 private:
  std::string name_;
  bool hw_;
  std::deque<Step> steps_;
  bool allow_reset_;
  std::vector<uint8_t> y_, uv_;
  std::deque<relay::EncodeResult> ready_;
};

relay::EncoderConfig baseConfig(const std::string& pref = "auto") {
  return {pref, 640, 360, 60, 8000000, true};
}

relay::EncoderFactories fakeHardware() {
  return {[](const relay::EncoderConfig&, relay::EncoderReadyCallback, std::string&) {
    return std::make_unique<ScriptedEncoder>("fake_hw", true, std::deque<ScriptedEncoder::Step>{});
  }, {}};
}

relay::EncodeResult encodedFrame(uint64_t encode_ns) {
  relay::EncodeResult result;
  result.status = relay::EncodeStatus::encoded;
  result.annex_b = validDelta();
  result.encode_ns = encode_ns;
  return result;
}
}  // namespace

int main() {
  using namespace relay;
  EncoderController::clearCooldowns();

  assert(hasNalUnit(validIdr(), 5) && hasNalUnit(validIdr(), 7) && hasNalUnit(validIdr(), 8));
  assert(!hasNalUnit(validDelta(), 5));
  assert(extractProfileLevelId(validIdr()) == "42c020");

  {
    int sw_opens = 0;
    EncoderFactories f;
    f.hardware = [](const EncoderConfig&, EncoderReadyCallback, std::string&) {
      return std::make_unique<ScriptedEncoder>("fake_hw", true, std::deque<ScriptedEncoder::Step>{
          {EncodeStatus::encoded, true, validIdr(), "", false},
      });
    };
    f.software = [&](const EncoderConfig&, EncoderReadyCallback, std::string&) {
      ++sw_opens;
      return std::make_unique<ScriptedEncoder>("fake_sw", false, std::deque<ScriptedEncoder::Step>{});
    };
    EncoderController ctrl(f);
    ctrl.open(baseConfig("auto"), {});
    assert(ctrl.state() == EncoderState::hardware_active);
    assert(ctrl.hardware() && ctrl.name() == "fake_hw");
    assert(std::strcmp(transferTierName(ctrl.transferTier()), "full_upload") == 0);
    assert(ctrl.profileLevelId() == "42c020");
    assert(sw_opens == 0);

    for (unsigned i = 0; i < EncoderController::max_consecutive_drops - 1; ++i) {
      EncodeResult dropped;
      dropped.status = EncodeStatus::dropped;
      const auto d = ctrl.evaluate(dropped, false);
      assert(d.action == EncoderAction::drop);
      assert(ctrl.state() == EncoderState::hardware_active);
    }
    EncodeResult ok;
    ok.status = EncodeStatus::encoded;
    ok.annex_b = validDelta();
    assert(ctrl.evaluate(ok, false).action == EncoderAction::publish);
    assert(ctrl.state() == EncoderState::hardware_active);
    assert(ctrl.droppedFrames() == EncoderController::max_consecutive_drops - 1);

    EncodeResult fail1;
    fail1.status = EncodeStatus::failed;
    fail1.error = "transient";
    const auto d1 = ctrl.evaluate(fail1, false);
    assert(d1.action == EncoderAction::recover_idr && !d1.switched_to_software);
    assert(ctrl.state() == EncoderState::hardware_active);

    EncodeResult fail2;
    fail2.status = EncodeStatus::encoded;
    fail2.keyframe = true;
    fail2.annex_b = validDelta();
    const auto d2 = ctrl.evaluate(fail2, true);
    assert(d2.action == EncoderAction::recover_idr && d2.switched_to_software);
    assert(ctrl.state() == EncoderState::software_active);
    assert(!ctrl.hardware() && ctrl.name() == "fake_sw");
    assert(ctrl.transferTier() == TransferTier::software);
    assert(ctrl.fallbackCount() == 1);
    assert(sw_opens == 1);
  }

  {
    EncoderController::clearCooldowns();
    EncoderFactories f;
    f.hardware = [](const EncoderConfig&, EncoderReadyCallback, std::string&) {
      return std::make_unique<ScriptedEncoder>("bad_probe_hw", true, std::deque<ScriptedEncoder::Step>{
          {EncodeStatus::encoded, true, validDelta(), "", false},
      });
    };
    f.software = [](const EncoderConfig&, EncoderReadyCallback, std::string&) {
      return std::make_unique<ScriptedEncoder>("x264", false, std::deque<ScriptedEncoder::Step>{});
    };
    EncoderController ctrl(f);
    ctrl.open(baseConfig("auto"), {});
    assert(ctrl.state() == EncoderState::software_active);
    assert(ctrl.name() == "x264");
  }

  {
    EncoderController::clearCooldowns();
    EncoderFactories f;
    f.hardware = [](const EncoderConfig&, EncoderReadyCallback, std::string& err) {
      err = "no gpu";
      return nullptr;
    };
    f.software = [](const EncoderConfig&, EncoderReadyCallback, std::string&) {
      return std::make_unique<ScriptedEncoder>("x264", false, std::deque<ScriptedEncoder::Step>{});
    };
    EncoderController ctrl(f);
    ctrl.open(baseConfig("x264"), {});
    assert(ctrl.state() == EncoderState::software_active);
    EncodeResult err;
    err.status = EncodeStatus::failed;
    err.error = "boom";
    assert(ctrl.evaluate(err, false).action == EncoderAction::recover_idr);
    assert(ctrl.evaluate(err, false).action == EncoderAction::recover_idr);
    assert(ctrl.evaluate(err, false).action == EncoderAction::fatal);
    assert(ctrl.state() == EncoderState::failed);
  }

  {
    EncoderController::clearCooldowns();
    EncoderFactories f;
    f.software = [](const EncoderConfig&, EncoderReadyCallback, std::string&) {
      return std::make_unique<ScriptedEncoder>("x264", false, std::deque<ScriptedEncoder::Step>{}, false);
    };
    EncoderController ctrl(f);
    ctrl.open(baseConfig("x264"), {});
    assert(ctrl.state() == EncoderState::software_active);
    EncodeResult err;
    err.status = EncodeStatus::failed;
    err.error = "boom";
    const auto decision = ctrl.evaluate(err, false);
    assert(decision.action == EncoderAction::fatal);
    assert(ctrl.state() == EncoderState::failed);
  }

  {
    EncoderController ctrl(fakeHardware());
    EncoderController::clearCooldowns();
    auto config = baseConfig();
    config.fps = 240;
    ctrl.open(config, {});
    const auto on_budget = encodedFrame(3'750'000);
    const auto slow = encodedFrame(3'750'001);
    const auto publish_on_hardware = [&](const EncodeResult& result) {
      const auto decision = ctrl.evaluate(result, false);
      assert(decision.action == EncoderAction::publish && !decision.switched_to_software);
      assert(ctrl.state() == EncoderState::hardware_active);
    };

    const unsigned misses_below_threshold = EncoderController::budget_miss_threshold - 1;
    const unsigned on_budget_count = EncoderController::budget_window_frames - misses_below_threshold;
    publish_on_hardware(slow);
    for (unsigned i = 0; i < on_budget_count; ++i) publish_on_hardware(on_budget);
    for (unsigned i = 1; i < misses_below_threshold; ++i) publish_on_hardware(slow);
    publish_on_hardware(slow);
    const auto decision = ctrl.evaluate(slow, false);
    assert(decision.action == EncoderAction::publish && decision.switched_to_software);
    assert(ctrl.state() == EncoderState::software_active && ctrl.name() == "x264");
    assert(ctrl.fallbackCount() == 1 && hardwareEncoderCoolingDown("fake_hw"));
    assert(std::strcmp(transferTierName(ctrl.transferTier()), "software") == 0);
  }

  {
    EncoderController ctrl(fakeHardware());
    ctrl.open(baseConfig("fake_hw"), {});
    const auto slow = encodedFrame(16'000'000);
    for (unsigned i = 0; i < 2 * EncoderController::budget_window_frames; ++i) {
      const auto decision = ctrl.evaluate(slow, false);
      assert(decision.action == EncoderAction::publish && !decision.switched_to_software);
      assert(ctrl.state() == EncoderState::hardware_active);
    }
    assert(ctrl.fallbackCount() == 0);
  }

  {
    EncoderController ctrl(fakeHardware());
    ctrl.open(baseConfig(), {});
    const auto first = ctrl.onSubmitFailure("first transient failure", false);
    assert(first.action == EncoderAction::recover_idr && !first.switched_to_software);
    const auto healthy = encodedFrame(1'000'000);
    for (unsigned i = 0; i < EncoderController::recovery_healthy_streak; ++i) {
      const auto decision = ctrl.evaluate(healthy, false);
      assert(decision.action == EncoderAction::publish && !decision.switched_to_software);
    }
    const auto second = ctrl.onSubmitFailure("second transient failure", false);
    assert(second.action == EncoderAction::recover_idr && !second.switched_to_software);
    assert(ctrl.state() == EncoderState::hardware_active && ctrl.fallbackCount() == 0);
  }

  {
    EncoderController::clearCooldowns();
    EncoderController real_ctrl;
    real_ctrl.open(baseConfig("auto"), {});
    assert(real_ctrl.state() == EncoderState::hardware_active || real_ctrl.state() == EncoderState::software_active);
    assert(!real_ctrl.name().empty());
    assert(!real_ctrl.profileLevelId().empty());
  }

  std::puts("encoder state machine checks passed");
  return 0;
}
