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
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

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
  long inputCount = 1, outputCount = 2;
  std::array<ASIOBufferInfo, 4> buffers {};
  std::array<ASIOChannelInfo, 4> channels {};
  std::atomic<unsigned> blocks {0};
  std::atomic<float> inputPeak {0.f};
  std::atomic<bool> interrupted {false};
  std::atomic<bool> latencyChanged {false};
  static constexpr uint32_t captureCapacity = 65536;
  std::vector<float> capture;
  std::atomic<uint32_t> captured {0}, drained {0};
  std::atomic<bool> captureOverflow {false};

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

  void start(long count, long input, long output, float gain, long captureChannels = 1) {
    if (!supportsFrames(count)) throw std::runtime_error("Requested buffer is outside the driver capabilities");
    if ((captureChannels != 1 && captureChannels != 2) || input < 0 || captureChannels > inputs || input > inputs - captureChannels)
      throw std::runtime_error("Requested ASIO input channel or stereo pair is unavailable");
    if (output < 0 || output >= outputs)
      throw std::runtime_error("Requested ASIO output channel is unavailable");
    frames = count;
    monitorGain = gain;
    inputCount = captureChannels;
    outputCount = output + 1 < outputs ? 2 : 1;
    const long channelCount = inputCount + outputCount;
    for (long index = 0; index < channelCount; ++index) {
      auto& channel = channels[index];
      channel.isInput = index < inputCount ? ASIOTrue : ASIOFalse;
      channel.channel = index < inputCount ? input + index : output + index - inputCount;
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
    float peak = inputPeak.load(std::memory_order_relaxed);
    const auto writeAt = captured.load(std::memory_order_relaxed);
    const auto blockSamples = static_cast<uint32_t>(frames * inputCount);
    const bool store = !capture.empty() && !captureOverflow.load(std::memory_order_relaxed)
      && writeAt - drained.load(std::memory_order_acquire) <= captureCapacity - blockSamples;
    if (!capture.empty() && !store) captureOverflow.store(true);
    for (long frame = 0; frame < frames; ++frame) {
      std::array<float, 2> samples {};
      for (long channel = 0; channel < inputCount; ++channel) {
        const auto* input = buffers[channel].buffers[index];
        const float sample = input ? readSample(input, channels[channel].type, frame) : 0.f;
        const float clean = std::isfinite(sample) ? sample : 0.f;
        samples[channel] = clean;
        peak = std::max(peak, std::abs(clean));
        if (store) capture[(writeAt + frame * inputCount + channel) % captureCapacity] = clean;
      }
      for (long output = 0; output < outputCount; ++output) {
        const long channel = inputCount + output;
        const float sample = inputCount == 1 ? samples[0] :
          outputCount == 1 ? (samples[0] + samples[1]) * 0.5f : samples[output];
        if (auto* target = buffers[channel].buffers[index])
          writeSample(target, channels[channel].type, frame, sample * monitorGain);
      }
    }
    if (store) captured.store(writeAt + blockSamples, std::memory_order_release);
    inputPeak.store(peak, std::memory_order_relaxed);
    blocks.fetch_add(1, std::memory_order_relaxed);
    if (outputReady) driver->outputReady();
  }

  void drainCapture(FILE* stream) {
    if (capture.empty()) return;
    auto readAt = drained.load(std::memory_order_relaxed);
    const auto writeAt = captured.load(std::memory_order_acquire);
    while (readAt != writeAt) {
      const auto offset = readAt % captureCapacity;
      const auto count = std::min(writeAt - readAt, captureCapacity - offset);
      if (std::fwrite(capture.data() + offset, sizeof(float), count, stream) != count)
        throw std::runtime_error("Could not send captured ASIO samples");
      readAt += count;
      drained.store(readAt, std::memory_order_release);
    }
    if (std::fflush(stream)) throw std::runtime_error("Could not flush captured ASIO samples");
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
            || value == kAsioLatenciesChanged || value == kAsioEngineVersion || value == kAsioSupportsTimeInfo;
      if (selector == kAsioEngineVersion) return 2;
      if (selector == kAsioSupportsTimeInfo) return 1;
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
    [](ASIOTime*, long index, ASIOBool) -> ASIOTime* {
      if (auto* device = Device::active.load()) device->onBlock(index);
      return nullptr;
    },
};

void verifyMonitorConversion() {
  Device device;
  std::array<int16_t, 4> input {16384, -16384, 0, 8192};
  std::array<float, 4> left {}, right {};
  device.frames = static_cast<long>(input.size());
  device.monitorGain = 0.25f;
  device.capture.resize(Device::captureCapacity);
  const auto start = Device::captureCapacity - 2;
  device.captured.store(start);
  device.drained.store(start);
  device.buffers[0].buffers[0] = input.data();
  device.buffers[1].buffers[0] = left.data();
  device.buffers[2].buffers[0] = right.data();
  device.channels[0].type = ASIOSTInt16LSB;
  device.channels[1].type = device.channels[2].type = ASIOSTFloat32LSB;
  device.onBlock(0);
  const std::array<float, 4> expected {0.125f, -0.125f, 0.f, 0.0625f};
  if (left != expected || right != expected || device.blocks.load() != 1 || device.inputPeak.load() != 0.5f)
    throw std::runtime_error("Native input monitoring conversion failed");
  if (device.captured.load() != start + 4 || device.capture[start] != 0.5f
      || device.capture[start + 1] != -0.5f || device.capture[0] != 0.f || device.capture[1] != 0.25f)
    throw std::runtime_error("Native capture ring did not retain the input block");
  device.drained.store(device.captured.load() - Device::captureCapacity);
  device.onBlock(0);
  if (!device.captureOverflow.load() || device.captured.load() != start + 4)
    throw std::runtime_error("Native capture ring failed to report an overflow");

  Device stereo;
  const std::array<float, 4> rightInput {-0.25f, 0.75f, 0.5f, -0.5f};
  stereo.frames = device.frames;
  stereo.inputCount = 2;
  stereo.monitorGain = 0.25f;
  stereo.capture.resize(Device::captureCapacity);
  stereo.captured.store(start);
  stereo.drained.store(start);
  stereo.buffers[0].buffers[0] = input.data();
  auto rightSamples = rightInput;
  stereo.buffers[1].buffers[0] = rightSamples.data();
  stereo.buffers[2].buffers[0] = left.data();
  stereo.buffers[3].buffers[0] = right.data();
  stereo.channels[0].type = ASIOSTInt16LSB;
  for (auto channel = 1; channel < 4; ++channel) stereo.channels[channel].type = ASIOSTFloat32LSB;
  stereo.onBlock(0);
  const std::array<float, 8> expectedPcm {0.5f, -0.25f, -0.5f, 0.75f, 0.f, 0.5f, 0.25f, -0.5f};
  if (stereo.captured.load() != start + expectedPcm.size() || left != expected)
    throw std::runtime_error("Native stereo capture frame count or left return failed");
  for (size_t sample = 0; sample < expectedPcm.size(); ++sample) {
    if (stereo.capture[(start + sample) % Device::captureCapacity] != expectedPcm[sample])
      throw std::runtime_error("Native stereo capture did not preserve both channels");
  }
  for (size_t frame = 0; frame < right.size(); ++frame) {
    if (right[frame] != rightInput[frame] * stereo.monitorGain)
      throw std::runtime_error("Native stereo monitoring did not preserve the right channel");
  }
}

void pumpMessages() {
  MSG message {};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
}

void report(const Device& device, std::ostream& output = std::cout) {
  output << "{\"inputs\":" << device.inputs << ",\"outputs\":" << device.outputs
    << ",\"sampleRate\":" << device.rate << ",\"minimum\":" << device.minimum << ",\"maximum\":" << device.maximum
    << ",\"preferred\":" << device.preferred << ",\"granularity\":" << device.step
    << ",\"frames\":" << device.frames << ",\"channels\":" << device.inputCount << ",\"inputLatency\":" << device.inputLatency
    << ",\"outputLatency\":" << device.outputLatency << ",\"callbacks\":" << device.blocks.load()
    << ",\"inputPeak\":" << device.inputPeak.load() << "}" << std::endl;
}

void monitor(Device& device, long frames, double rate, long input, long output, FILE* capturePipe, float gain, long channels) {
  const HANDLE parent = GetStdHandle(STD_INPUT_HANDLE);
  if (GetFileType(parent) != FILE_TYPE_PIPE) throw std::runtime_error("Monitoring requires a parent process pipe");
  device.setSampleRate(rate);
  const long blockSize = frames == 0 ? device.preferred : frames;
  if (capturePipe) {
    if (blockSize <= 0 || blockSize > Device::captureCapacity / 2)
      throw std::runtime_error("Unsupported capture block size");
    device.capture.resize(Device::captureCapacity);
  }
  // Keep the initial return level conservative. Audio stays on the driver callback.
  device.start(blockSize, input, output, gain, channels);
  auto lastCallback = std::chrono::steady_clock::now();
  unsigned seen = 0;
  while (PeekNamedPipe(parent, nullptr, 0, nullptr, nullptr, nullptr)) {
    pumpMessages();
    if (device.interrupted.load()) throw std::runtime_error("ASIO requested a stream reset");
    const auto now = std::chrono::steady_clock::now();
    const auto count = device.blocks.load(std::memory_order_relaxed);
    if (count != seen) {
      if (!seen) {
        if (capturePipe) {
          std::ostringstream metadata;
          report(device, metadata);
          const auto line = "VALE_ASIO_READY " + metadata.str();
          if (std::fwrite(line.data(), 1, line.size(), capturePipe) != line.size() || std::fflush(capturePipe))
            throw std::runtime_error("Could not confirm ASIO capture");
        } else {
          std::cout << "VALE_ASIO_READY ";
          report(device);
        }
      }
      seen = count;
      lastCallback = now;
    } else if (now - lastCallback > std::chrono::seconds(2)) {
      throw std::runtime_error("The ASIO driver stopped delivering audio callbacks");
    }
    if (seen) device.drainCapture(capturePipe);
    if (device.captureOverflow.load()) throw std::runtime_error("ASIO capture queue overflowed");
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  device.stop();
  if (seen) device.drainCapture(capturePipe);
  if (device.captureOverflow.load()) throw std::runtime_error("ASIO capture queue overflowed");
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
    const bool capturing = action == L"--capture";
    if (argc < 3 || (action != L"--probe" && action != L"--verify" && action != L"--monitor" && !capturing)) {
      std::cerr << "Usage: vale-asio-host --probe DRIVER | --verify DRIVER FRAMES [RATE [INPUT OUTPUT]] | --monitor DRIVER FRAMES RATE INPUT OUTPUT | --capture DRIVER FRAMES RATE INPUT OUTPUT RETURN [CHANNELS] | --self-test\n";
      return 64;
    }
    std::unique_ptr<FILE, decltype(&std::fclose)> capturePipe(nullptr, std::fclose);
    if (capturing) {
      const int fd = _dup(_fileno(stdout));
      if (fd < 0) throw std::runtime_error("Could not duplicate the capture pipe");
      capturePipe.reset(_fdopen(fd, "wb"));
      if (!capturePipe) { _close(fd); throw std::runtime_error("Could not open the capture pipe"); }
      if (_setmode(fd, _O_BINARY) < 0 || _dup2(_fileno(stderr), _fileno(stdout)) < 0
          || !SetStdHandle(STD_OUTPUT_HANDLE, reinterpret_cast<HANDLE>(_get_osfhandle(_fileno(stderr)))))
        throw std::runtime_error("Could not isolate the capture pipe");
    }
    ComApartment com;
    Device device;
    device.open(argv[2]);
    if (action == L"--monitor" || capturing) {
      if ((!capturing && argc != 7 && argc != 8) || (capturing && argc != 8 && argc != 9))
        throw std::runtime_error("Specify frames, rate, input, output and capture options");
      const float gain = !capturing || std::wstring(argv[7]) == L"1" ? 0.125f : 0.f;
      const int channelArg = capturing ? 8 : 7;
      const long channels = argc > channelArg ? std::stol(argv[channelArg]) : 1;
      monitor(device, std::stol(argv[3]), std::stod(argv[4]), std::stol(argv[5]), std::stol(argv[6]), capturePipe.get(), gain, channels);
      return 0;
    }
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
        pumpMessages();
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      device.stop();
      if (device.interrupted.load()) throw std::runtime_error("ASIO requested a stream reset");
      if (!device.blocks.load()) throw std::runtime_error("ASIO start returned success, but the driver delivered no audio callbacks");
    }
    report(device);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
