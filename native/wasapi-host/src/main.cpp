#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <initguid.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ks.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;

namespace {
void check(HRESULT result, const char* operation) {
  if (FAILED(result)) {
    char code[16];
    std::snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(result));
    throw std::runtime_error(std::string(operation) + " (" + code + ")");
  }
}

struct Com {
  Com() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "CoInitializeEx"); }
  ~Com() { CoUninitialize(); }
};

struct Event {
  HANDLE handle = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  Event() { if (!handle) throw std::runtime_error("CreateEvent failed"); }
  ~Event() { CloseHandle(handle); }
};

struct Mmcss {
  DWORD task = 0;
  HANDLE handle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  ~Mmcss() { if (handle) AvRevertMmThreadCharacteristics(handle); }
};

struct CoFree {
  void operator()(void* pointer) const { CoTaskMemFree(pointer); }
};

std::string json(const wchar_t* value) {
  const int length = static_cast<int>(wcslen(value));
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, value, length, nullptr, 0, nullptr, nullptr);
  std::string utf8(bytes, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, length, utf8.data(), bytes, nullptr, nullptr);
  std::string escaped = "\"";
  for (unsigned char character : utf8) {
    if (character == '"' || character == '\\') escaped += '\\';
    if (character < 32) {
      char control[7];
      std::snprintf(control, sizeof(control), "\\u%04x", character);
      escaped += control;
    } else escaped += static_cast<char>(character);
  }
  return escaped + '"';
}

ComPtr<IMMDeviceEnumerator> enumerator() {
  ComPtr<IMMDeviceEnumerator> result;
  check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&result)), "MMDeviceEnumerator");
  return result;
}

void list(IMMDeviceEnumerator* devices) {
  std::cout << '[';
  bool first = true;
  for (const auto flow : {eCapture, eRender}) {
    ComPtr<IMMDeviceCollection> endpoints;
    check(devices->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &endpoints), "EnumAudioEndpoints");
    UINT count = 0;
    check(endpoints->GetCount(&count), "GetCount");
    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> device;
      check(endpoints->Item(index, &device), "IMMDeviceCollection::Item");
      LPWSTR id = nullptr;
      check(device->GetId(&id), "IMMDevice::GetId");
      const std::unique_ptr<wchar_t, CoFree> ownedId(id);
      std::string name = json(id);
      ComPtr<IPropertyStore> store;
      if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store))) {
        PROPVARIANT property;
        PropVariantInit(&property);
        if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &property)) && property.vt == VT_LPWSTR)
          name = json(property.pwszVal);
        PropVariantClear(&property);
      }
      if (!first) std::cout << ',';
      first = false;
      ComPtr<IAudioClient3> client;
      WAVEFORMATEX* mix = nullptr;
      UINT32 standard = 0, fundamental = 0, minimum = 0, maximum = 0;
      if (SUCCEEDED(device->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())))
          && SUCCEEDED(client->GetMixFormat(&mix))) {
        client->GetSharedModeEnginePeriod(mix, &standard, &fundamental, &minimum, &maximum);
      }
      const std::unique_ptr<WAVEFORMATEX, CoFree> ownedMix(mix);
      std::cout << "{\"id\":" << json(id) << ",\"name\":" << name
                << ",\"flow\":\"" << (flow == eCapture ? "input" : "output")
                << "\",\"sampleRate\":" << (mix ? mix->nSamplesPerSec : 0)
                << ",\"channels\":" << (mix ? mix->nChannels : 0) << ",\"standard\":" << standard
                << ",\"fundamental\":" << fundamental << ",\"minimum\":" << minimum << ",\"maximum\":" << maximum << '}';
    }
  }
  std::cout << "]\n";
}

struct Stream {
  Event event;
  ComPtr<IAudioClient3> client;
  std::unique_ptr<WAVEFORMATEX, CoFree> format;
  UINT32 period = 0, buffer = 0;
  bool started = false;

  Stream(IMMDeviceEnumerator* devices, EDataFlow flow, const wchar_t* id, UINT32 requested) {
    ComPtr<IMMDevice> device;
    check(*id ? devices->GetDevice(id, &device) : devices->GetDefaultAudioEndpoint(flow, eMultimedia, &device), "Selecionar dispositivo WASAPI");
    ComPtr<IMMEndpoint> endpoint;
    EDataFlow actual;
    check(device.As(&endpoint), "IMMEndpoint");
    check(endpoint->GetDataFlow(&actual), "GetDataFlow");
    if (flow != actual) throw std::runtime_error("Direção do dispositivo WASAPI inválida");
    check(device->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())), "Ativar WASAPI Shared");
    WAVEFORMATEX* mix = nullptr;
    check(client->GetMixFormat(&mix), "GetMixFormat");
    format.reset(mix);
    UINT32 standard, fundamental, minimum, maximum;
    check(client->GetSharedModeEnginePeriod(mix, &standard, &fundamental, &minimum, &maximum), "GetSharedModeEnginePeriod");
    period = requested ? requested : standard;
    if (!fundamental || period < minimum || period > maximum || period % fundamental)
      throw std::runtime_error("Período incompatível. Use Automático ou um período suportado pelo dispositivo.");
    check(client->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, mix, nullptr), "InitializeSharedAudioStream");
    check(client->SetEventHandle(event.handle), "SetEventHandle");
    check(client->GetBufferSize(&buffer), "GetBufferSize");
  }

  void start() {
    check(client->Start(), "Iniciar WASAPI");
    started = true;
  }
  ~Stream() { if (started) client->Stop(); }
};

enum class Sample { Float, Int16, Int24, Int32 };

Sample sampleType(const WAVEFORMATEX& format) {
  const auto* extended = format.wFormatTag == WAVE_FORMAT_EXTENSIBLE && format.cbSize >= 22
    ? reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(&format) : nullptr;
  if ((format.wFormatTag == WAVE_FORMAT_IEEE_FLOAT || (extended && extended->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT))
      && format.wBitsPerSample == 32) return Sample::Float;
  if (format.wFormatTag == WAVE_FORMAT_PCM || (extended && extended->SubFormat == KSDATAFORMAT_SUBTYPE_PCM)) {
    if (format.wBitsPerSample == 16) return Sample::Int16;
    if (format.wBitsPerSample == 24) return Sample::Int24;
    if (format.wBitsPerSample == 32) return Sample::Int32;
  }
  throw std::runtime_error("Formato PCM de entrada não suportado");
}

template<typename T> T load(const BYTE* data) {
  T value;
  std::memcpy(&value, data, sizeof(value));
  return value;
}

float decode(const BYTE* data, Sample sample) {
  switch (sample) {
    case Sample::Float: {
      const auto value = load<float>(data);
      return std::isfinite(value) ? value : 0.f;
    }
    case Sample::Int16: return load<int16_t>(data) / 32768.f;
    case Sample::Int24: {
      const int32_t signedByte = static_cast<int8_t>(data[2]);
      return (signedByte * 65536 + data[1] * 256 + data[0]) / 8388608.f;
    }
    case Sample::Int32: return load<int32_t>(data) / 2147483648.f;
  }
  return 0.f;
}

template<typename T> void store(BYTE* data, T value) {
  std::memcpy(data, &value, sizeof(value));
}

void encode(BYTE* data, Sample sample, float value) {
  const float normalized = std::isfinite(value) ? std::clamp(value, -1.f, 1.f) : 0.f;
  switch (sample) {
    case Sample::Float: store(data, normalized); break;
    case Sample::Int16: store(data, static_cast<int16_t>(std::lround(normalized * 32767))); break;
    case Sample::Int24: {
      const auto bits = static_cast<uint32_t>(std::lround(normalized * 8388607));
      data[0] = static_cast<BYTE>(bits);
      data[1] = static_cast<BYTE>(bits >> 8);
      data[2] = static_cast<BYTE>(bits >> 16);
      break;
    }
    case Sample::Int32: store(data, static_cast<int32_t>(std::llround(static_cast<double>(normalized) * 2147483647))); break;
  }
}

class CaptureRing {
  static constexpr uint32_t capacity = 65536;
  std::array<float, capacity> data {};
  std::atomic<uint32_t> head {0}, tail {0};
public:
  bool append(const BYTE* input, UINT32 frames, const WAVEFORMATEX& format, Sample sample, UINT32 first, UINT32 channels) {
    auto at = head.load(std::memory_order_relaxed);
    if (frames > (capacity - (at - tail.load(std::memory_order_acquire))) / channels) return false;
    const UINT32 bytes = format.wBitsPerSample / 8;
    for (UINT32 frame = 0; frame < frames; ++frame) {
      for (UINT32 channel = 0; channel < channels; ++channel)
        data[at++ % capacity] = input ? decode(input + frame * format.nBlockAlign + (first + channel) * bytes, sample) : 0.f;
    }
    head.store(at, std::memory_order_release);
    return true;
  }
  bool drain() {
    auto at = tail.load(std::memory_order_relaxed);
    const auto end = head.load(std::memory_order_acquire);
    while (at != end) {
      const auto offset = at % capacity;
      const auto count = std::min(end - at, capacity - offset);
      if (std::fwrite(data.data() + offset, sizeof(float), count, stdout) != count) return false;
      at += count;
      tail.store(at, std::memory_order_release);
    }
    return std::fflush(stdout) == 0;
  }
};

class RecordingOutput {
  Stream& stream;
  ComPtr<IAudioRenderClient> render;
  Sample type;
  std::vector<float> backing, monitor;
  size_t cursor = 0, head = 0, count = 0;
  size_t monitorTarget;
  UINT32 emptyBuffers = 0, monitorDrops = 0, monitorUnderruns = 0;
  bool dryReturn, monitoring = false;
public:
  UINT32 latencyFrames;

  RecordingOutput(Stream& output, UINT32 inputRate, UINT32 inputPeriod, bool dry, size_t frames)
    : stream(output), type(sampleType(*output.format)),
      monitorTarget(std::max(output.buffer, output.period + inputPeriod)), dryReturn(dry) {
    if (dry && inputRate != stream.format->nSamplesPerSec)
      throw std::runtime_error("O retorno WASAPI exige a mesma taxa de amostragem na entrada e na saída");
    if (frames > (192u * 1024 * 1024) / (2 * sizeof(float)))
      throw std::runtime_error("A base WASAPI excede o limite de duração");
    if (dry) monitor.resize(monitorTarget * 8);
    backing.resize(frames * 2);
    if (frames && (_setmode(_fileno(stdin), _O_BINARY) < 0 ||
        std::fread(backing.data(), sizeof(float), backing.size(), stdin) != backing.size()))
      throw std::runtime_error("A base WASAPI chegou incompleta");
    check(stream.client->GetService(IID_PPV_ARGS(&render)), "IAudioRenderClient");
    REFERENCE_TIME latency = 0;
    check(stream.client->GetStreamLatency(&latency), "Consultar latência da saída WASAPI");
    latencyFrames = static_cast<UINT32>(std::max<REFERENCE_TIME>(0, latency) * stream.format->nSamplesPerSec / 10000000);
  }

  void push(const BYTE* data, UINT32 frames, const WAVEFORMATEX& format, Sample sample, UINT32 first, UINT32 channels) {
    if (!dryReturn) return;
    const auto bytes = format.wBitsPerSample / 8;
    const auto capacity = monitor.size() / 2;
    for (UINT32 frame = 0; frame < frames; ++frame) {
      if (count == capacity) {
        head = (head + 1) % capacity;
        --count;
        ++monitorDrops;
      }
      const auto index = ((head + count) % capacity) * 2;
      const auto* source = data ? data + frame * format.nBlockAlign + first * bytes : nullptr;
      monitor[index] = source ? decode(source, sample) : 0.f;
      monitor[index + 1] = channels == 2 && source ? decode(source + bytes, sample) : monitor[index];
      ++count;
    }
  }

  void fill() {
    UINT32 padding;
    check(stream.client->GetCurrentPadding(&padding), "Consultar saída durante a gravação");
    if (stream.started && !padding) ++emptyBuffers;
    const UINT32 frames = stream.buffer - padding;
    if (!frames) return;
    BYTE* data;
    check(render->GetBuffer(frames, &data), "Abrir saída durante a gravação");
    const auto& format = *stream.format;
    const auto bytes = format.wBitsPerSample / 8;
    std::memset(data, 0, static_cast<size_t>(frames) * format.nBlockAlign);
    if (stream.started && dryReturn && count >= monitorTarget) monitoring = true;
    for (UINT32 frame = 0; frame < frames; ++frame) {
      float left = 0.f, right = 0.f;
      if (cursor < backing.size()) {
        left = backing[cursor++];
        right = backing[cursor++];
      }
      if (monitoring && count) {
        left += monitor[head * 2] * 0.5f;
        right += monitor[head * 2 + 1] * 0.5f;
        head = (head + 1) % (monitor.size() / 2);
        --count;
      } else if (monitoring) {
        monitoring = false;
        ++monitorUnderruns;
      }
      auto* target = data + frame * format.nBlockAlign;
      encode(target, type, format.nChannels == 1 ? (left + right) * 0.5f : left);
      if (format.nChannels > 1) encode(target + bytes, type, right);
    }
    check(render->ReleaseBuffer(frames, 0), "Entregar saída durante a gravação");
  }

  void report() const {
    std::cerr << "VALE_WASAPI_STATS {\"renderedBackingFrames\":" << cursor / 2
              << ",\"emptyOutputBuffers\":" << emptyBuffers << ",\"monitorDroppedFrames\":" << monitorDrops
              << ",\"monitorUnderruns\":" << monitorUnderruns
              << ",\"monitorPrimingFrames\":" << (dryReturn ? monitorTarget : 0) << "}\n";
  }
};

void capture(Stream& stream, UINT32 first, UINT32 channels, Stream* outputStream = nullptr, bool dryReturn = false, size_t backingFrames = 0) {
  const auto& format = *stream.format;
  if (channels < 1 || channels > 2 || first >= format.nChannels || channels > format.nChannels - first)
    throw std::runtime_error("O dispositivo não oferece os canais de captura solicitados");
  const auto sample = sampleType(format);
  REFERENCE_TIME latency = 0;
  check(stream.client->GetStreamLatency(&latency), "Consultar latência WASAPI");
  const auto latencyFrames = static_cast<UINT32>(std::max<REFERENCE_TIME>(0, latency) * format.nSamplesPerSec / 10000000);
  ComPtr<IAudioCaptureClient> capture;
  check(stream.client->GetService(IID_PPV_ARGS(&capture)), "IAudioCaptureClient");
  if (GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE)
    throw std::runtime_error("A captura requer o pipe de controle do aplicativo");
  std::unique_ptr<RecordingOutput> output;
  if (outputStream) output = std::make_unique<RecordingOutput>(*outputStream, format.nSamplesPerSec, stream.period, dryReturn, backingFrames);
  if (_setmode(_fileno(stdout), _O_BINARY) < 0) throw std::runtime_error("Pipe PCM indisponível");
  Event stop, flush;
  auto ring = std::make_unique<CaptureRing>();
  std::atomic<bool> received {false}, failed {false};
  std::jthread control([&](std::stop_token quit) {
    while (!quit.stop_requested()) {
      if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, nullptr, nullptr)) {
        SetEvent(stop.handle);
        return;
      }
      std::this_thread::sleep_for(20ms);
    }
  });
  std::jthread writer([&](std::stop_token quit) {
    bool announced = false;
    while (true) {
      WaitForSingleObject(flush.handle, 30);
      if (!announced && received.load()) {
        std::fprintf(stdout, "VALE_ASIO_READY {\"frames\":%u,\"bufferFrames\":%u,\"channels\":%u,\"sampleRate\":%lu,\"inputLatency\":%u,\"outputLatency\":%u,\"callbacks\":1}\n",
          stream.period, stream.buffer, channels, format.nSamplesPerSec, latencyFrames, output ? output->latencyFrames : 0);
        announced = true;
      }
      if (announced && !ring->drain()) { failed.store(true); SetEvent(stop.handle); return; }
      if (quit.stop_requested()) return;
    }
  });

  stream.start();
  const Mmcss priority;
  const HANDLE events[] = {stop.handle, stream.event.handle, outputStream ? outputStream->event.handle : nullptr};
  auto lastCapture = std::chrono::steady_clock::now();
  while (true) {
    const DWORD event = WaitForMultipleObjects(outputStream && outputStream->started ? 3 : 2, events, FALSE, 2000);
    if (event == WAIT_OBJECT_0) break;
    if (event == WAIT_OBJECT_0 + 2) {
      if (std::chrono::steady_clock::now() - lastCapture >= 2s)
        throw std::runtime_error("WASAPI parou de entregar blocos de entrada");
      output->fill();
      continue;
    }
    if (event != WAIT_OBJECT_0 + 1) throw std::runtime_error("WASAPI parou de entregar blocos de entrada");
    UINT32 queued;
    check(capture->GetNextPacketSize(&queued), "Consultar captura");
    while (queued) {
      BYTE* data;
      UINT32 frames;
      DWORD flags;
      check(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr), "Ler captura");
      const bool interrupted = received.load() && (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY);
      const auto* pcm = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? nullptr : data;
      const bool retained = !interrupted && ring->append(pcm, frames, format, sample, first, channels);
      if (retained && output) output->push(pcm, frames, format, sample, first, channels);
      check(capture->ReleaseBuffer(frames), "Liberar captura");
      if (interrupted) throw std::runtime_error("Descontinuidade no dispositivo de captura WASAPI");
      if (!retained) throw std::runtime_error("A fila PCM atingiu o limite");
      lastCapture = std::chrono::steady_clock::now();
      if (outputStream && !outputStream->started) {
        output->fill();
        outputStream->start();
      }
      received.store(true);
      SetEvent(flush.handle);
      check(capture->GetNextPacketSize(&queued), "Consultar captura");
    }
  }
  if (output) output->report();
  if (failed.load()) throw std::runtime_error("O pipe de captura foi interrompido");
}

void verifyOutput(Stream& stream, unsigned seconds) {
  if (seconds < 1 || seconds > 300) throw std::runtime_error("Duração de teste inválida");
  ComPtr<IAudioRenderClient> render;
  check(stream.client->GetService(IID_PPV_ARGS(&render)), "IAudioRenderClient");
  BYTE* data;
  check(render->GetBuffer(stream.buffer, &data), "Preparar saída");
  check(render->ReleaseBuffer(stream.buffer, AUDCLNT_BUFFERFLAGS_SILENT), "Preparar silêncio");
  stream.start();
  unsigned callbacks = 0, emptyBuffers = 0;
  {
    const Mmcss priority;
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
    while (std::chrono::steady_clock::now() < end) {
      if (WaitForSingleObject(stream.event.handle, 2000) != WAIT_OBJECT_0)
        throw std::runtime_error("WASAPI parou de solicitar blocos de saída");
      UINT32 padding;
      check(stream.client->GetCurrentPadding(&padding), "Consultar saída");
      if (!padding) ++emptyBuffers;
      const auto count = stream.buffer - padding;
      if (count) {
        check(render->GetBuffer(count, &data), "Abrir bloco de saída");
        check(render->ReleaseBuffer(count, AUDCLNT_BUFFERFLAGS_SILENT), "Entregar bloco de saída");
      }
      ++callbacks;
    }
  }
  std::cout << "{\"sampleRate\":" << stream.format->nSamplesPerSec << ",\"period\":" << stream.period
            << ",\"buffer\":" << stream.buffer << ",\"callbacks\":" << callbacks << ",\"emptyBuffers\":" << emptyBuffers << "}\n";
}

void play(Stream& stream, UINT32 sampleRate, UINT32 frames) {
  if (sampleRate != stream.format->nSamplesPerSec || frames == 0 || frames > (192u * 1024 * 1024) / (2 * sizeof(float)))
    throw std::runtime_error("Formato ou duração incompatível com a saída WASAPI");
  if (_setmode(_fileno(stdin), _O_BINARY) < 0) throw std::runtime_error("Pipe de reprodução indisponível");
  std::vector<float> samples(static_cast<size_t>(frames) * 2);
  if (std::fread(samples.data(), sizeof(float), samples.size(), stdin) != samples.size())
    throw std::runtime_error("O áudio para reprodução chegou incompleto");
  const auto type = sampleType(*stream.format);
  const auto channels = stream.format->nChannels;
  const auto frameBytes = stream.format->nBlockAlign;
  const auto sampleBytes = stream.format->wBitsPerSample / 8;
  ComPtr<IAudioRenderClient> render;
  check(stream.client->GetService(IID_PPV_ARGS(&render)), "IAudioRenderClient");
  UINT32 cursor = 0;
  const auto fill = [&](UINT32 capacity) {
    const UINT32 count = std::min(capacity, frames - cursor);
    if (!count) return;
    BYTE* data;
    check(render->GetBuffer(count, &data), "Abrir bloco de reprodução");
    std::memset(data, 0, static_cast<size_t>(count) * frameBytes);
    for (UINT32 i = 0; i < count; ++i) {
      auto* target = data + i * frameBytes;
      const float left = samples[(cursor + i) * 2];
      const float right = samples[(cursor + i) * 2 + 1];
      encode(target, type, channels == 1 ? (left + right) * 0.5f : left);
      if (channels > 1) encode(target + sampleBytes, type, right);
    }
    check(render->ReleaseBuffer(count, 0), "Entregar bloco de reprodução");
    cursor += count;
  };
  fill(stream.buffer);
  stream.start();
  unsigned callbacks = 0, emptyBuffers = 0;
  {
    const Mmcss priority;
    while (true) {
      if (WaitForSingleObject(stream.event.handle, 2000) != WAIT_OBJECT_0)
        throw std::runtime_error("WASAPI parou de solicitar blocos de saída");
      UINT32 padding;
      check(stream.client->GetCurrentPadding(&padding), "Consultar saída");
      if (cursor == frames && !padding) break;
      if (!padding) ++emptyBuffers;
      ++callbacks;
      fill(stream.buffer - padding);
    }
  }
  std::cout << "{\"sampleRate\":" << sampleRate << ",\"period\":" << stream.period << ",\"buffer\":" << stream.buffer
            << ",\"renderedFrames\":" << cursor << ",\"callbacks\":" << callbacks << ",\"emptyBuffers\":" << emptyBuffers << "}\n";
}
}

int wmain(int argc, wchar_t** argv) {
  try {
    const Com com;
    const auto devices = enumerator();
    const std::wstring operation = argc > 1 ? argv[1] : L"";
    if (operation == L"--list" && argc == 2) list(devices.Get());
    else if (operation == L"--capture" && argc == 6) {
      Stream stream(devices.Get(), eCapture, argv[2], std::stoul(argv[3]));
      capture(stream, std::stoul(argv[4]), std::stoul(argv[5]));
    } else if (operation == L"--duplex" && argc == 11) {
      Stream input(devices.Get(), eCapture, argv[2], std::stoul(argv[3]));
      Stream output(devices.Get(), eRender, argv[6], std::stoul(argv[7]));
      if (output.format->nSamplesPerSec != std::stoul(argv[8]))
        throw std::runtime_error("A taxa da saída WASAPI mudou. Atualize a lista de dispositivos.");
      capture(input, std::stoul(argv[4]), std::stoul(argv[5]), &output, std::wstring(argv[9]) == L"1", std::stoul(argv[10]));
    } else if (operation == L"--verify-output" && argc == 5) {
      Stream stream(devices.Get(), eRender, argv[2], std::stoul(argv[3]));
      verifyOutput(stream, std::stoul(argv[4]));
    } else if (operation == L"--play" && argc == 6) {
      Stream stream(devices.Get(), eRender, argv[2], std::stoul(argv[3]));
      play(stream, std::stoul(argv[4]), std::stoul(argv[5]));
    } else throw std::runtime_error("Use --list, --capture ID PERIOD FIRST CHANNELS ou --verify-output ID PERIOD SECONDS");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
