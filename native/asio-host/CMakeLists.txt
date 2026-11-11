cmake_minimum_required(VERSION 3.25)
project(ValeStudioAsioHost LANGUAGES CXX)

set(ASIO_SDK_ROOT "" CACHE PATH "Path to an ASIO SDK checkout")
if(NOT WIN32 OR NOT EXISTS "${ASIO_SDK_ROOT}/common/iasiodrv.h")
  message(FATAL_ERROR "Use Windows and set ASIO_SDK_ROOT to the ASIO SDK directory.")
endif()

add_executable(vale-asio-host src/main.cpp)
target_compile_features(vale-asio-host PRIVATE cxx_std_20)
target_compile_definitions(vale-asio-host PRIVATE NOMINMAX UNICODE _UNICODE)
target_include_directories(vale-asio-host PRIVATE "${ASIO_SDK_ROOT}/common" "${ASIO_SDK_ROOT}/host")
target_link_libraries(vale-asio-host PRIVATE ole32 advapi32 user32)
