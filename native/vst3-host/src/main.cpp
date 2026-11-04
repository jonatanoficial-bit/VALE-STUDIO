// Vale Studio VST3 host: a short-lived, isolated scanner. It never runs in the
// Tauri/UI process, so an invalid plug-in cannot take down the project editor.
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

struct PluginRecord {
  std::string bundlePath;
  std::string classId;
  std::string name;
  std::string vendor;
  std::string version;
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
    plugins.push_back({
      path.string(),
      info.ID().toString(),
      info.name(),
      info.vendor(),
      info.version(),
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
              << "\",\"version\":\"" << escapeJson(plugin.version) << "\"}";
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

static ProbeResult probePlugin(const fs::path& path, const std::string& classId) {
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
        Steinberg::Vst::ProcessSetup setup {};
        setup.processMode = Steinberg::Vst::kRealtime;
        setup.symbolicSampleSize = Steinberg::Vst::kSample32;
        setup.maxSamplesPerBlock = 512;
        setup.sampleRate = 48000.0;
        if (processor->setupProcessing(setup) != Steinberg::kResultOk) {
          result.message = "O plug-in recusou a configuração de áudio em 48 kHz.";
        } else if (component->setActive(true) != Steinberg::kResultOk) {
          result.message = "O plug-in não pôde ser ativado.";
        } else if (processor->setProcessing(true) != Steinberg::kResultOk) {
          component->setActive(false);
          result.message = "O plug-in não entrou no modo de processamento.";
        } else {
          processor->setProcessing(false);
          component->setActive(false);
          result = {true, "Componente VST3 inicializado e pronto para a cadeia desktop."};
        }
      } else {
        result.message = "A classe não expôs IAudioProcessor.";
      }
    }
    Steinberg::Vst::PluginContextFactory::instance().setPluginContext(nullptr);
  }
  return result;
}

int main(int argc, char* argv[]) {
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
  if (!fs::is_directory(root)) {
    std::cerr << "A pasta VST3 não existe." << std::endl;
    return 66;
  }

  std::vector<PluginRecord> plugins;
  std::vector<std::string> errors;
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
