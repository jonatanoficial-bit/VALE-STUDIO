cmake_minimum_required(VERSION 3.25)
project(ValeStudioVst3Host VERSION 0.1.0 LANGUAGES CXX)

set(VST3_SDK_ROOT "" CACHE PATH "Caminho absoluto para o checkout recursivo do vst3sdk")
if(NOT VST3_SDK_ROOT OR NOT EXISTS "${VST3_SDK_ROOT}/CMakeLists.txt")
  message(FATAL_ERROR "Defina -DVST3_SDK_ROOT=<checkout do vst3sdk>")
endif()

list(APPEND CMAKE_MODULE_PATH "${VST3_SDK_ROOT}/cmake/modules")
include(SMTG_VST3_SDK)

set(SDK_ROOT "${VST3_SDK_ROOT}")
set(public_sdk_SOURCE_DIR "${SDK_ROOT}/public.sdk")
set(pluginterfaces_SOURCE_DIR "${SDK_ROOT}/pluginterfaces")
set(VST_SDK TRUE)

smtg_setup_platform_toolset()
smtg_setup_symbol_visibility()
smtg_create_lib_base_target()
smtg_create_pluginterfaces_target()
smtg_create_public_sdk_common_target()
smtg_create_public_sdk_target()
smtg_create_public_sdk_hosting_target()

add_executable(vst3-host src/main.cpp)
target_sources(vst3-host PRIVATE
  "${SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
  "${SDK_ROOT}/public.sdk/source/vst/hosting/connectionproxy.cpp"
)
if(SMTG_WIN)
  # The hosting target is cross-platform; the SDK keeps the dynamic module
  # loader in a platform source file that the host executable must select.
  target_sources(vst3-host PRIVATE "${SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp")
elseif(SMTG_LINUX)
  target_sources(vst3-host PRIVATE "${SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp")
else()
  message(FATAL_ERROR "Este host inicial suporta somente Windows e Linux.")
endif()
target_compile_features(vst3-host PRIVATE cxx_std_20)
target_include_directories(vst3-host PRIVATE "${SDK_ROOT}")
target_link_libraries(vst3-host PRIVATE sdk sdk_common sdk_hosting base pluginterfaces)

set_target_properties(vst3-host PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/dist"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/dist"
)
