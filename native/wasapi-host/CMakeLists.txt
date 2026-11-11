cmake_minimum_required(VERSION 3.25)
project(ValeStudioWasapiHost LANGUAGES CXX)

add_executable(wasapi-host src/main.cpp)
target_compile_features(wasapi-host PRIVATE cxx_std_20)
target_compile_definitions(wasapi-host PRIVATE NOMINMAX UNICODE _UNICODE)
target_link_libraries(wasapi-host PRIVATE ole32 uuid avrt)
set_target_properties(wasapi-host PROPERTIES
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/dist"
)
