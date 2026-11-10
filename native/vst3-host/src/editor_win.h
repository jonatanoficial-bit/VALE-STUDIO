#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"

class PluginEditor final : public Steinberg::IPlugFrame, public Steinberg::Vst::IComponentHandler {
  using View = Steinberg::IPlugView;
  using Rect = Steinberg::ViewRect;
  using Controller = Steinberg::Vst::IEditController;
  Controller* controller;
  Steinberg::IPtr<View> view;
  HWND window = nullptr;
  bool attached = false;
  Steinberg::Vst::ParameterChangeTransfer transfer {2048};

  static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
    auto* self = reinterpret_cast<PluginEditor*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (self && message == WM_CLOSE) {
      ShowWindow(hwnd, SW_HIDE);
      return 0;
    }
    if (self && self->attached && message == WM_SIZE && wp != SIZE_MINIMIZED) {
      Rect size(0, 0, LOWORD(lp), HIWORD(lp));
      self->view->onSize(&size);
    }
    return DefWindowProcW(hwnd, message, wp, lp);
  }

public:
  static constexpr UINT showMessage = WM_APP + 37;
  explicit PluginEditor(Controller* value) : controller(value) {
    if (controller) controller->setComponentHandler(this);
  }
  ~PluginEditor() {
    if (attached) view->removed();
    if (view) view->setFrame(nullptr);
    if (window) DestroyWindow(window);
    if (controller) controller->setComponentHandler(nullptr);
  }

  void show() {
    using namespace Steinberg;
    if (!controller) return;
    if (!window) {
      view = owned(controller->createView(Vst::ViewType::kEditor));
      if (!view || view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) return;
      Rect bounds {};
      if (view->getSize(&bounds) != kResultTrue) return;
      WNDCLASSW type {};
      type.lpfnWndProc = windowProc;
      type.hInstance = GetModuleHandleW(nullptr);
      type.lpszClassName = L"ValeStudioPluginEditor";
      type.hCursor = LoadCursor(nullptr, IDC_ARROW);
      RegisterClassW(&type);
      constexpr DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
      RECT frame {0, 0, bounds.getWidth(), bounds.getHeight()};
      AdjustWindowRect(&frame, style, FALSE);
      window = CreateWindowExW(0, type.lpszClassName, L"Vale Studio • VST3", style,
        CW_USEDEFAULT, CW_USEDEFAULT, frame.right - frame.left, frame.bottom - frame.top,
        nullptr, nullptr, type.hInstance, nullptr);
      if (!window) return;
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
      view->setFrame(this);
      if (view->attached(window, kPlatformTypeHWND) != kResultTrue) {
        view->setFrame(nullptr);
        DestroyWindow(window);
        window = nullptr;
        return;
      }
      attached = true;
    }
    ShowWindow(window, SW_SHOWNORMAL);
    SetForegroundWindow(window);
  }

  void transferTo(Steinberg::Vst::ParameterChanges& changes) {
    transfer.transferChangesTo(changes);
  }

  Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID iid, void** object) override {
    using namespace Steinberg;
    *object = nullptr;
    if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      *object = static_cast<IPlugFrame*>(this);
    } else if (FUnknownPrivate::iidEqual(iid, Vst::IComponentHandler::iid)) {
      *object = static_cast<Vst::IComponentHandler*>(this);
    }
    return *object ? kResultOk : kNoInterface;
  }
  Steinberg::uint32 PLUGIN_API addRef() override { return 1; }
  Steinberg::uint32 PLUGIN_API release() override { return 1; }
  Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID) override { return Steinberg::kResultOk; }
  Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID) override { return Steinberg::kResultOk; }
  Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID id, Steinberg::Vst::ParamValue value) override {
    transfer.addChange(id, value, 0);
    return Steinberg::kResultOk;
  }
  Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32) override { return Steinberg::kNotImplemented; }
  Steinberg::tresult PLUGIN_API resizeView(View* target, Rect* size) override {
    if (!window || target != view.get() || !size) return Steinberg::kInvalidArgument;
    RECT frame {0, 0, size->getWidth(), size->getHeight()};
    AdjustWindowRect(&frame, static_cast<DWORD>(GetWindowLongPtrW(window, GWL_STYLE)), FALSE);
    SetWindowPos(window, nullptr, 0, 0, frame.right - frame.left, frame.bottom - frame.top, SWP_NOMOVE | SWP_NOZORDER);
    return Steinberg::kResultOk;
  }
};
