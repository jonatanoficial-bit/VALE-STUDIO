// Vale Studio VST3 host: a short-lived, isolated scanner. It never runs in the
// Tauri/UI process, so an invalid plug-in cannot take down the project editor.
#include "public.sdk/source/vst/hosting/module.h"
#include "pluginterfaces/vst/ivstcomponent.h"

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

static std::string escapeJson(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size() + 8);
  for (const char character : value) {
    switch (character) {
      case '\\': escaped += "\\\\"; break;
      case '"': escaped += "\\\""; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (static_cast<unsigned char>(character) >= 0x20) escaped += character;
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
    if (info.category() != Steinberg::Vst::kVstAudioEffectClass) continue;
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

int main(int argc, char* argv[]) {
  if (argc != 3 || std::string(argv[1]) != "--scan") {
    std::cerr << "Uso: vst3-host --scan <pasta-de-plugins-vst3>" << std::endl;
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
