#include <windows.h>
#include <objbase.h>
#include "asiosys.h"
#include "asio.h"
#include "iasiodrv.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
struct ComApartment {
  ComApartment() {
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) throw std::runtime_error("COM initialization failed");
  }
  ~ComApartment() { CoUninitialize(); }
};

bool supported(ASIOSampleType type) {
  return type == ASIOSTInt16LSB || type == ASIOSTInt24LSB || type == ASIOSTInt32LSB
      || type == ASIOSTFloat32LSB || type == ASIOSTFloat64LSB;
}

float readSample(const void* data, ASIOSampleType type, long frame) {
  switch (type) {
    case ASIOSTInt16LSB: return static_cast<const int16_t*>(data)[frame] / 32768.f;
    case ASIOSTInt24LSB: {
      const auto* bytes = static_cast<const uint8_t*>(data) + frame * 3;
      const int32_t packed = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
      return ((packed ^ 0x800000) - 0x800000) / 8388608.f;
    }
    case ASIOSTInt32LSB: return static_cast<float>(static_cast<const int32_t*>(data)[frame] / 2147483648.0);
    case ASIOSTFloat32LSB: return static_cast<const float*>(data)[frame];
    case ASIOSTFloat64LSB: return static_cast<float>(static_cast<const double*>(data)[frame]);
    default: return 0.f;
  }
}

void writeSample(void* data, ASIOSampleType type, long frame, float input) {
  const double sample = std::clamp(static_cast<double>(input), -1.0, 1.0);
  switch (type) {
    case ASIOSTInt16LSB: static_cast<int16_t*>(data)[frame] = static_cast<int16_t>(sample * 32767.0); break;
    case ASIOSTInt24LSB: {
      const auto packed = static_cast<uint32_t>(static_cast<int32_t>(sample * 8388607.0));
      auto* bytes = static_cast<uint8_t*>(data) + frame * 3;
      for (int i = 0; i < 3; ++i) bytes[i] = static_cast<uint8_t>(packed >> (8 * i));
      break;
    }
    case ASIOSTInt32LSB: static_cast<int32_t*>(data)[frame] = static_cast<int32_t>(sample * 2147483647.0); break;
    case ASIOSTFloat32LSB: static_cast<float*>(data)[frame] = static_cast<float>(sample); break;
    case ASIOSTFloat64LSB: static_cast<double*>(data)[frame] = sample; break;
  }
}

struct Device {
  IASIO* driver = nullptr;
  long inputs = 0, outputs = 0, minimum = 0, maximum = 0, preferred = 0, step = 0;
  long frames = 0, inputLatency = 0, outputLatency = 0;
  ASIOSampleRate rate = 0;
  bool allocated = false, running = false, outputReady = false;
  float monitorGain = 0;
  std::array<ASIOBufferInfo, 3> buffers {};
  std::array<ASIOChannelInfo, 3> channels {};
  std::atomic<unsigned> blocks {0};
  std::atomic<float> inputPeak {0.f};
  std::atomic<bool> interrupted {false};
  std::atomic<bool> latencyChanged {false};

  ~Device() {
    if (running) driver->stop();
    if (allocated) driver->disposeBuffers();
    active.store(nullptr);
    if (driver) driver->Release();
  }

  void open(const std::wstring& name) {
    if (name.empty() || name.find(L'\\') != std::wstring::npos) throw std::runtime_error("Invalid ASIO driver name");
    std::array<wchar_t, 64> value {};
    DWORD bytes = static_cast<DWORD>(sizeof(value));
    const auto key = L"SOFTWARE\\ASIO\\" + name;
    if (RegGetValueW(HKEY_LOCAL_MACHINE, key.c_str(), L"CLSID", RRF_RT_REG_SZ, nullptr, value.data(), &bytes) != ERROR_SUCCESS)
      throw std::runtime_error("ASIO driver registration not found");
    CLSID id {};
    if (FAILED(CLSIDFromString(value.data(), &id))
        || FAILED(CoCreateInstance(id, nullptr, CLSCTX_INPROC_SERVER, id, reinterpret_cast<void**>(&driver))))
      throw std::runtime_error("Could not load the 64-bit ASIO driver");
    if (!driver->init(GetDesktopWindow())) {
      char error[128] {};
      driver->getErrorMessage(error);
      throw std::runtime_error(std::string("ASIO initialization failed: ") + error);
    }
    if (driver->getChannels(&inputs, &outputs) != ASE_OK
        || driver->getBufferSize(&minimum, &maximum, &preferred, &step) != ASE_OK
        || driver->getSampleRate(&rate) != ASE_OK || !std::isfinite(rate) || rate <= 0)
      throw std::runtime_error("Could not read ASIO device configuration");
  }

  bool supportsFrames(long count) const {
    if (count < minimum || count > maximum || count <= 0) return false;
    if (step == -1) return (count & (count - 1)) == 0;
    if (step == 0) return count == preferred;
    return step > 0 && (count - minimum) % step == 0;
  }

  void setSampleRate(ASIOSampleRate requested) {
    if (requested < 8000 || requested > 192000 || !std::isfinite(requested))
      throw std::runtime_error("Invalid sample rate");
    if (rate != requested) {
      const auto possible = driver->canSampleRate(requested);
      if (possible != ASE_OK)
        throw std::runtime_error("ASIO canSampleRate rejected the request (" + std::to_string(possible) + ")");
      const auto changed = driver->setSampleRate(requested);
      if (changed != ASE_OK)
        throw std::runtime_error("ASIO setSampleRate rejected the request (" + std::to_string(changed) + ")");
    }
    if (driver->getSampleRate(&rate) != ASE_OK || std::abs(rate - requested) > 1
        || driver->getBufferSize(&minimum, &maximum, &preferred, &step) != ASE_OK)
      throw std::runtime_error("Could not confirm ASIO sample rate and buffer limits");
  }

  void start(long count, long input, long output, float gain) {
    if (!supportsFrames(count)) throw std::runtime_error("Requested buffer is outside the driver capabilities");
    if (input < 0 || input >= inputs || output < 0 || output >= outputs)
      throw std::runtime_error("Requested input or output channel is unavailable");
    frames = count;
    monitorGain = gain;
    const long channelCount = output + 1 < outputs ? 3 : 2;
    for (long index = 0; index < channelCount; ++index) {
      auto& channel = channels[index];
      channel.isInput = index == 0 ? ASIOTrue : ASIOFalse;
      channel.channel = index == 0 ? input : output + index - 1;
      if (driver->getChannelInfo(&channel) != ASE_OK || !supported(channel.type))
        throw std::runtime_error("Unsupported ASIO channel sample format");
      buffers[index].isInput = channel.isInput;
      buffers[index].channelNum = channel.channel;
    }
    outputReady = driver->outputReady() == ASE_OK;
    active.store(this);
    if (driver->createBuffers(buffers.data(), channelCount, frames, &callbacks) != ASE_OK)
      throw std::runtime_error("ASIO driver rejected buffer creation");
    allocated = true;
    if (driver->getLatencies(&inputLatency, &outputLatency) != ASE_OK)
      throw std::runtime_error("ASIO driver did not report latency");
    if (driver->start() != ASE_OK) throw std::runtime_error("ASIO driver could not start");
    running = true;
  }

  void onBlock(long index) noexcept {
    if (index != 0 && index != 1) return;
    const auto* input = buffers[0].buffers[index];
    float peak = inputPeak.load(std::memory_order_relaxed);
    for (long frame = 0; frame < frames; ++frame) {
      const float sample = input ? readSample(input, channels[0].type, frame) : 0.f;
      const float clean = std::isfinite(sample) ? sample : 0.f;
      peak = std::max(peak, std::abs(clean));
      for (int channel = 1; channel < 3; ++channel) {
        if (auto* target = buffers[channel].buffers[index])
          writeSample(target, channels[channel].type, frame, clean * monitorGain);
      }
    }
    inputPeak.store(peak, std::memory_order_relaxed);
    blocks.fetch_add(1, std::memory_order_relaxed);
    if (outputReady) driver->outputReady();
  }

  void stop() {
    if (!running) return;
    if (driver->stop() != ASE_OK) throw std::runtime_error("ASIO driver refused to stop");
    running = false;
    if (latencyChanged.load()) driver->getLatencies(&inputLatency, &outputLatency);
  }

  void listChannels() const {
    for (const bool input : {true, false}) {
      for (long index = 0; index < (input ? inputs : outputs); ++index) {
        ASIOChannelInfo channel {};
        channel.isInput = input ? ASIOTrue : ASIOFalse;
        channel.channel = index;
        if (driver->getChannelInfo(&channel) == ASE_OK) {
          channel.name[sizeof(channel.name) - 1] = '\0';
          std::cerr << (input ? "Input " : "Output ") << index << ": " << channel.name
                    << " (format " << channel.type << ")\n";
        }
      }
    }
  }

  static inline std::atomic<Device*> active {nullptr};
  static ASIOCallbacks callbacks;
};

ASIOCallbacks Device::callbacks {
    [](long index, ASIOBool) { if (auto* device = Device::active.load()) device->onBlock(index); },
    [](ASIOSampleRate rate) {
      if (auto* device = Device::active.load(); device && std::abs(device->rate - rate) > 1) device->interrupted.store(true);
    },
    [](long selector, long value, void*, double*) -> long {
      if (selector == kAsioSelectorSupported)
        return value == kAsioResetRequest || value == kAsioBufferSizeChange || value == kAsioResyncRequest
            || value == kAsioLatenciesChanged || value == kAsioEngineVersion;
      if (selector == kAsioEngineVersion) return 2;
      if (selector == kAsioLatenciesChanged) {
        if (auto* device = Device::active.load()) device->latencyChanged.store(true);
        return 1;
      }
      if (selector == kAsioResetRequest || selector == kAsioBufferSizeChange || selector == kAsioResyncRequest) {
        if (auto* device = Device::active.load()) device->interrupted.store(true);
        return 1;
      }
      return 0;
    },
    nullptr,
};

void verifyMonitorConversion() {
  Device device;
  std::array<int16_t, 4> input {16384, -16384, 0, 8192};
  std::array<float, 4> left {}, right {};
  device.frames = static_cast<long>(input.size());
  device.monitorGain = 0.25f;
  device.buffers[0].buffers[0] = input.data();
  device.buffers[1].buffers[0] = left.data();
  device.buffers[2].buffers[0] = right.data();
  device.channels[0].type = ASIOSTInt16LSB;
  device.channels[1].type = device.channels[2].type = ASIOSTFloat32LSB;
  device.onBlock(0);
  const std::array<float, 4> expected {0.125f, -0.125f, 0.f, 0.0625f};
  if (left != expected || right != expected || device.blocks.load() != 1 || device.inputPeak.load() != 0.5f)
    throw std::runtime_error("Native input monitoring conversion failed");
}
}

int wmain(int argc, wchar_t** argv) {
  try {
    const std::wstring action = argc > 1 ? argv[1] : L"";
    if (action == L"--self-test" && argc == 2) {
      verifyMonitorConversion();
      std::cout << "Native input monitoring conversion passed\n";
      return 0;
    }
    if (argc < 3 || (action != L"--probe" && action != L"--verify")) {
      std::cerr << "Usage: vale-asio-host --probe DRIVER | --verify DRIVER FRAMES [RATE [INPUT OUTPUT]] | --self-test\n";
      return 64;
    }
    ComApartment com;
    Device device;
    device.open(argv[2]);
    const bool verify = action == L"--verify";
    if (!verify) device.listChannels();
    if (verify) {
      if (argc != 4 && argc != 5 && argc != 7) throw std::runtime_error("Specify frames and optionally sample rate and both channel indexes");
      const long requested = std::stol(argv[3]);
      if (argc >= 5) device.setSampleRate(std::stod(argv[4]));
      device.start(requested == 0 ? device.preferred : requested,
        argc == 7 ? std::stol(argv[5]) : 0, argc == 7 ? std::stol(argv[6]) : 0, 0.f);
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(700);
      while (std::chrono::steady_clock::now() < deadline && !device.interrupted.load()) {
        MSG message {};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      device.stop();
      if (device.interrupted.load()) throw std::runtime_error("ASIO requested a stream reset");
      if (!device.blocks.load()) throw std::runtime_error("ASIO start returned success, but the driver delivered no audio callbacks");
    }
    std::cout << "{\"inputs\":" << device.inputs << ",\"outputs\":" << device.outputs
      << ",\"sampleRate\":" << device.rate << ",\"minimum\":" << device.minimum << ",\"maximum\":" << device.maximum
      << ",\"preferred\":" << device.preferred << ",\"granularity\":" << device.step
      << ",\"frames\":" << device.frames << ",\"inputLatency\":" << device.inputLatency
      << ",\"outputLatency\":" << device.outputLatency << ",\"callbacks\":" << device.blocks.load()
      << ",\"inputPeak\":" << device.inputPeak.load() << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
