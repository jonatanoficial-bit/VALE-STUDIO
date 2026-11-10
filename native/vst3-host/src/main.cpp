// Vale Studio VST3 host: a short-lived, isolated scanner. It never runs in the
// Tauri/UI process, so an invalid plug-in cannot take down the project editor.
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cstdint>
#include <cstdio>
#include <thread>
#ifdef _WIN32
#include "editor_win.h"
#include <fcntl.h>
#include <io.h>
#endif
#include <string>
#include <vector>

namespace fs = std::filesystem;
static FILE* audioOutput = stdout;

static void restorePluginState(const fs::path& file, Steinberg::Vst::IComponent& component,
                               Steinberg::Vst::IEditController* controller) {
  if (file.empty()) return;
  std::ifstream input(file, std::ios::binary | std::ios::ate);
  const auto length = input.tellg();
  if (length <= 0 || length > 32 * 1024 * 1024) return;
  std::vector<char> bytes(static_cast<size_t>(length));
  if (!input.seekg(0).read(bytes.data(), bytes.size())) return;
  Steinberg::MemoryStream stream(bytes.data(), bytes.size());
  if (component.setState(&stream) == Steinberg::kResultOk && controller) {
    stream.seek(0, Steinberg::IBStream::kIBSeekSet, nullptr);
    controller->setComponentState(&stream);
  }
}

#ifdef _WIN32
static void savePluginState(const fs::path& file, Steinberg::Vst::IComponent& component) {
  if (file.empty()) return;
  Steinberg::MemoryStream stream;
  if (component.getState(&stream) != Steinberg::kResultOk || stream.getSize() <= 0 || stream.getSize() > 32 * 1024 * 1024) return;
  auto temporary = file;
  temporary += L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp";
  std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
  output.write(stream.getData(), stream.getSize());
  output.close();
  if (output) MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING);
}
#endif

struct PluginRecord {
  std::string bundlePath;
  std::string classId;
  std::string name;
  std::string vendor;
  std::string version;
  std::string kind;
};

struct ProbeResult {
  bool compatible;
  std::string message;
};

static std::string escapeJson(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size() + 8);
  for (size_t index = 0; index < value.size(); ++index) {
    const unsigned char byte = static_cast<unsigned char>(value[index]);
    const char character = static_cast<char>(byte);
    switch (character) {
      case '\\': escaped += "\\\\"; break;
      case '"': escaped += "\\\""; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (byte < 0x20) break;
        if (byte < 0x80) {
          escaped += character;
          break;
        }
        const size_t sequenceLength = (byte >= 0xC2 && byte <= 0xDF) ? 2 : (byte >= 0xE0 && byte <= 0xEF) ? 3 : (byte >= 0xF0 && byte <= 0xF4) ? 4 : 0;
        const bool validUtf8 = sequenceLength > 0 && index + sequenceLength <= value.size() && [&] {
          for (size_t offset = 1; offset < sequenceLength; ++offset) {
            if ((static_cast<unsigned char>(value[index + offset]) & 0xC0) != 0x80) return false;
          }
          return true;
        }();
        if (validUtf8) {
          escaped.append(value, index, sequenceLength);
          index += sequenceLength - 1;
        } else {
          constexpr char hex[] = "0123456789abcdef";
          escaped += "\\u00";
          escaped += hex[(byte >> 4) & 0x0F];
          escaped += hex[byte & 0x0F];
        }
    }
  }
  return escaped;
}

static void inspectModule(const fs::path& path, std::vector<PluginRecord>& plugins, std::vector<std::string>& errors) {
  std::string error;
  auto module = VST3::Hosting::Module::create(path.string(), error);
  if (!module) {
    errors.push_back(path.string() + ": " + (error.empty() ? "não pôde ser aberto" : error));
    return;
  }
  for (const auto& info : module->getFactory().classInfos()) {
    if (info.category() != kVstAudioEffectClass) continue;
    const auto subCategories = info.subCategoriesString();
    const auto lowerSubCategories = [&] {
      std::string value = subCategories;
      std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
      return value;
    }();
    plugins.push_back({
      path.string(),
      info.ID().toString(),
      info.name(),
      info.vendor(),
      info.version(),
      lowerSubCategories.find("instrument") != std::string::npos ? "instrument" : "effect",
    });
  }
}

static void writeJson(const std::vector<PluginRecord>& plugins, const std::vector<std::string>& errors) {
  std::cout << "{\"plugins\":[";
  for (size_t index = 0; index < plugins.size(); ++index) {
    const auto& plugin = plugins[index];
    if (index) std::cout << ',';
    std::cout << "{\"bundlePath\":\"" << escapeJson(plugin.bundlePath)
              << "\",\"classId\":\"" << escapeJson(plugin.classId)
              << "\",\"name\":\"" << escapeJson(plugin.name)
              << "\",\"vendor\":\"" << escapeJson(plugin.vendor)
              << "\",\"version\":\"" << escapeJson(plugin.version)
              << "\",\"kind\":\"" << plugin.kind << "\"}";
  }
  std::cout << "],\"errors\":[";
  for (size_t index = 0; index < errors.size(); ++index) {
    if (index) std::cout << ',';
    std::cout << '"' << escapeJson(errors[index]) << '"';
  }
  std::cout << "]}" << std::endl;
}

static void writeProbeJson(const ProbeResult& result) {
  std::cout << "{\"compatible\":" << (result.compatible ? "true" : "false")
            << ",\"message\":\"" << escapeJson(result.message) << "\"}" << std::endl;
}

static bool streamAudio(Steinberg::Vst::IAudioProcessor& processor,
                        Steinberg::Vst::HostProcessData& data,
                        Steinberg::Vst::EventList& events,
                        Steinberg::Vst::EventList& outputEvents,
                        Steinberg::Vst::ProcessContext& context
#ifdef _WIN32
                        , PluginEditor& editor, DWORD uiThread
#endif
                        ) {
  using namespace Steinberg;
  using namespace Steinberg::Vst;
  const auto frames = data.numSamples;
  std::vector<float> stereo(frames * 2);
  const char ready = 1;
  if (std::fwrite(&ready, 1, 1, audioOutput) != 1 || std::fflush(audioOutput)) return false;
#ifdef _WIN32
  ParameterChanges inputChanges(2048);
  data.inputParameterChanges = &inputChanges;
#endif
  while (std::cin.read(reinterpret_cast<char*>(stereo.data()), stereo.size() * sizeof(float))) {
    uint32_t count = 0;
    if (!std::cin.read(reinterpret_cast<char*>(&count), sizeof(count))) return false;
#ifdef _WIN32
    if (count & 0x80000000u) PostThreadMessageW(uiThread, PluginEditor::showMessage, 0, 0);
#endif
    count &= 0x7fffffffu;
    if (count > 1024) return false;
    events.clear();
    outputEvents.clear();
    for (uint32_t i = 0; i < count; ++i) {
      uint32_t message[4];
      if (!std::cin.read(reinterpret_cast<char*>(message), sizeof(message))) return false;
      if (message[0] >= static_cast<uint32_t>(frames) || message[1] > 127 || message[2] > 127 || message[3] > 15) return false;
      Event event {};
      event.sampleOffset = static_cast<int32>(message[0]);
      event.type = message[2] ? Event::kNoteOnEvent : Event::kNoteOffEvent;
      if (message[2]) {
        event.noteOn.channel = static_cast<int16>(message[3]);
        event.noteOn.pitch = static_cast<int16>(message[1]);
        event.noteOn.velocity = message[2] / 127.0f;
        event.noteOn.noteId = -1;
      } else {
        event.noteOff.channel = static_cast<int16>(message[3]);
        event.noteOff.pitch = static_cast<int16>(message[1]);
        event.noteOff.noteId = -1;
      }
      events.addEvent(event);
    }
    for (int32 bus = 0; bus < data.numInputs; ++bus) {
      auto& input = data.inputs[bus];
      input.silenceFlags = bus == 0 ? 0 : HostProcessData::kAllChannelsSilent;
      for (int32 channel = 0; channel < input.numChannels; ++channel) {
        for (int32 frame = 0; frame < frames; ++frame) {
          auto* samples = input.channelBuffers32[channel];
          samples[frame] = 0.0f;
          if (bus != 0 || channel > 1) continue;
          samples[frame] = input.numChannels == 1
            ? (stereo[frame * 2] + stereo[frame * 2 + 1]) * 0.5f
            : stereo[frame * 2 + channel];
        }
      }
    }
    for (int32 bus = 0; bus < data.numOutputs; ++bus) {
      auto& output = data.outputs[bus];
      output.silenceFlags = 0;
      for (int32 channel = 0; channel < output.numChannels; ++channel) {
        std::fill_n(output.channelBuffers32[channel], frames, 0.0f);
      }
    }
#ifdef _WIN32
    inputChanges.clearQueue();
    editor.transferTo(inputChanges);
#endif
    if (processor.process(data) != kResultOk) return false;
    const auto& output = data.outputs[0];
    for (int32 frame = 0; frame < frames; ++frame) {
      for (int32 channel = 0; channel < 2; ++channel) {
        const auto sample = output.channelBuffers32[std::min(channel, output.numChannels - 1)][frame];
        stereo[frame * 2 + channel] = std::isfinite(sample) ? sample : 0.0f;
      }
    }
    if (std::fwrite(stereo.data(), sizeof(float), stereo.size(), audioOutput) != stereo.size()
        || std::fflush(audioOutput)) return false;
    context.projectTimeSamples += frames;
    context.continousTimeSamples += frames;
    context.projectTimeMusic = context.projectTimeSamples * context.tempo / (60.0 * context.sampleRate);
  }
  return std::cin.eof();
}

static ProbeResult processPlugin(Steinberg::Vst::IComponent& component,
                                 Steinberg::Vst::IAudioProcessor& processor,
                                 Steinberg::Vst::IEditController* controller,
                                 int frames, double sampleRate, double tempo, bool stream, const fs::path& statePath) {
  using namespace Steinberg;
  using namespace Steinberg::Vst;
  ProcessSetup setup {kRealtime, kSample32, frames, sampleRate};
  if (processor.setupProcessing(setup) != kResultOk) {
    return {false, "O plug-in recusou a configuração de áudio."};
  }

  for (const auto media : {kAudio, kEvent}) {
    for (const auto direction : {kInput, kOutput}) {
      for (int32 index = 0; index < component.getBusCount(media, direction); ++index) {
        BusInfo info {};
        if (component.getBusInfo(media, direction, index, info) == kResultOk) {
          component.activateBus(media, direction, index, info.busType == kMain);
        }
      }
    }
  }

  HostProcessData data;
  if (!data.prepare(component, frames, kSample32) || data.numOutputs == 0 || data.outputs[0].numChannels == 0) {
    return {false, "O plug-in não disponibilizou uma saída de áudio para o teste."};
  }
  data.processMode = kRealtime;
  data.numSamples = frames;
  for (int32 bus = 0; bus < data.numInputs; ++bus) {
    for (int32 channel = 0; channel < data.inputs[bus].numChannels; ++channel) {
      auto* samples = data.inputs[bus].channelBuffers32[channel];
      for (int32 frame = 0; frame < frames; ++frame) {
        samples[frame] = bus == 0 ? static_cast<float>(0.1 * std::sin(frame * 0.057595865)) : 0.0f;
      }
    }
    data.inputs[bus].silenceFlags = bus == 0 ? 0 : HostProcessData::kAllChannelsSilent;
  }
  for (int32 bus = 0; bus < data.numOutputs; ++bus) {
    for (int32 channel = 0; channel < data.outputs[bus].numChannels; ++channel) {
      std::fill_n(data.outputs[bus].channelBuffers32[channel], frames, 0.0f);
    }
  }
  EventList inputEvents;
  EventList outputEvents;
  if (component.getBusCount(kEvent, kInput) > 0) {
    Event note {};
    note.type = Event::kNoteOnEvent;
    note.noteOn.pitch = 60;
    note.noteOn.velocity = 0.75f;
    note.noteOn.noteId = -1;
    inputEvents.addEvent(note);
    data.inputEvents = &inputEvents;
  }
  data.outputEvents = &outputEvents;
  ProcessContext context {};
  context.sampleRate = setup.sampleRate;
  context.tempo = tempo;
  context.timeSigNumerator = 4;
  context.timeSigDenominator = 4;
  context.state = ProcessContext::kPlaying | ProcessContext::kTempoValid | ProcessContext::kTimeSigValid
    | ProcessContext::kProjectTimeMusicValid | ProcessContext::kContTimeValid;
  data.processContext = &context;

  if (component.setActive(true) != kResultOk) {
    return {false, "O plug-in não pôde ser ativado."};
  }
  const auto processing = processor.setProcessing(true);
  // The SDK permits kNotImplemented for this lifecycle notification.
  if (processing != kResultOk && processing != kNotImplemented) {
    component.setActive(false);
    return {false, "O plug-in não entrou no modo de processamento."};
  }
  tresult result = kResultFalse;
  if (!stream) {
    result = processor.process(data);
  } else {
#ifdef _WIN32
    PluginEditor editor(controller);
    const DWORD uiThread = GetCurrentThreadId();
    MSG message {};
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    bool editorOpened = false;
    std::thread worker([&] {
      if (streamAudio(processor, data, inputEvents, outputEvents, context, editor, uiThread)) result = kResultOk;
      PostThreadMessageW(uiThread, WM_QUIT, 0, 0);
    });
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      if (message.message == PluginEditor::showMessage) {
        editor.show();
        if (!editorOpened && !statePath.empty()) SetTimer(nullptr, 0, 2000, nullptr);
        editorOpened = true;
      } else if (message.message == WM_TIMER && !message.hwnd && editorOpened) {
        savePluginState(statePath, component);
      } else {
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
    }
    worker.join();
    if (editorOpened) savePluginState(statePath, component);
#else
    (void)controller;
    if (streamAudio(processor, data, inputEvents, outputEvents, context)) result = kResultOk;
#endif
  }
  processor.setProcessing(false);
  component.setActive(false);
  if (result != kResultOk) return {false, "O plug-in recusou o bloco de teste."};
  for (int32 bus = 0; bus < data.numOutputs; ++bus) {
    for (int32 channel = 0; channel < data.outputs[bus].numChannels; ++channel) {
      const auto* samples = data.outputs[bus].channelBuffers32[channel];
      if (!std::all_of(samples, samples + frames, [](float value) { return std::isfinite(value); })) {
        return {false, "O plug-in produziu amostras inválidas no teste."};
      }
    }
  }
  return {true, "Bloco de teste processado em 48 kHz. Teste isolado da sessão."};
}

static ProbeResult probePlugin(const fs::path& path, const std::string& classId,
                               int frames = 512, double rate = 48000, double tempo = 120, bool stream = false,
                               const fs::path& statePath = {}) {
  std::string error;
  auto module = VST3::Hosting::Module::create(path.string(), error);
  if (!module) return {false, error.empty() ? "Não foi possível abrir o módulo VST3." : error};

  const auto& classInfos = module->getFactory().classInfos();
  const auto classInfo = std::find_if(classInfos.begin(), classInfos.end(), [&](const auto& info) {
    return info.category() == kVstAudioEffectClass && info.ID().toString() == classId;
  });
  if (classInfo == classInfos.end()) return {false, "A classe de efeito não foi encontrada neste módulo."};

  ProbeResult result {false, "O componente não pôde ser inicializado."};
  {
    Steinberg::Vst::HostApplication hostApplication;
    Steinberg::Vst::PluginContextFactory::instance().setPluginContext(&hostApplication);
    Steinberg::Vst::PlugProvider provider(module->getFactory(), *classInfo, true);
    if (!provider.initialize()) {
      result.message = "O plug-in recusou a inicialização do componente.";
    } else if (auto component = provider.getComponentPtr()) {
      if (auto processor = Steinberg::U::cast<Steinberg::Vst::IAudioProcessor>(component)) {
        const auto controller = provider.getControllerPtr();
        restorePluginState(statePath, *component, controller.get());
        result = processPlugin(*component, *processor, controller.get(), frames, rate, tempo, stream, statePath);
      } else {
        result.message = "A classe não expôs IAudioProcessor.";
      }
    }
    Steinberg::Vst::PluginContextFactory::instance().setPluginContext(nullptr);
  }
  return result;
}

int main(int argc, char* argv[]) {
  if ((argc == 7 || argc == 8) && std::string(argv[1]) == "--stream") {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    const int output = _dup(_fileno(stdout));
    if (output < 0) return 74;
    audioOutput = _fdopen(output, "wb");
    if (!audioOutput || _dup2(_fileno(stderr), _fileno(stdout)) < 0) return 74;
#endif
    try {
      const int frames = std::stoi(argv[4]);
      const double rate = std::stod(argv[5]);
      const double tempo = std::stod(argv[6]);
      if (frames < 128 || frames > 4096 || !std::isfinite(rate) || rate < 8000 || rate > 192000
          || !std::isfinite(tempo) || tempo < 20 || tempo > 400) return 64;
      const auto result = probePlugin(fs::path(argv[2]), argv[3], frames, rate, tempo, true, argc == 8 ? fs::path(argv[7]) : fs::path());
      if (!result.compatible) std::cerr << result.message << std::endl;
      return result.compatible ? 0 : 65;
    } catch (const std::exception&) {
      return 64;
    }
  }
  if (argc == 4 && std::string(argv[1]) == "--probe") {
    const fs::path path(argv[2]);
    if (path.extension() != ".vst3") {
      writeProbeJson({false, "O caminho informado não é um módulo .vst3."});
      return 0;
    }
    writeProbeJson(probePlugin(path, argv[3]));
    return 0;
  }
  if (argc != 3 || std::string(argv[1]) != "--scan") {
    std::cerr << "Uso: vst3-host --scan <pasta-de-plugins-vst3> | --probe <módulo.vst3> <class-id>" << std::endl;
    return 64;
  }
  const fs::path root(argv[2]);
  const bool singleModule = root.extension() == ".vst3" && fs::exists(root);
  if (!singleModule && !fs::is_directory(root)) {
    std::cerr << "A pasta VST3 não existe." << std::endl;
    return 66;
  }

  std::vector<PluginRecord> plugins;
  std::vector<std::string> errors;
  if (singleModule) {
    inspectModule(root, plugins, errors);
    writeJson(plugins, errors);
    return 0;
  }
  try {
    for (fs::recursive_directory_iterator iterator(root, fs::directory_options::skip_permission_denied), end; iterator != end; ++iterator) {
      const auto& path = iterator->path();
      if (path.extension() != ".vst3") continue;
      inspectModule(path, plugins, errors);
      if (iterator->is_directory()) iterator.disable_recursion_pending();
    }
  } catch (const fs::filesystem_error& error) {
    errors.push_back(error.what());
  }
  writeJson(plugins, errors);
  return 0;
}
