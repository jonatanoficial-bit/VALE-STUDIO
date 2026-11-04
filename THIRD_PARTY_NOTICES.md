# Third-party notices

- React and React DOM: MIT License.
- Vite and its build-time dependencies: MIT License.
- lamejs 1.2.1: JavaScript port of the LAME MP3 encoder, LGPL-3.0. The self-contained browser bundle is included locally for actual MP3 encoding; its license and distribution terms must accompany each production release.
- Tauri 2: MIT or Apache-2.0. The desktop build uses it as the native Windows shell.
- Steinberg VST 3 SDK: MIT for the current SDK interface and hosting helpers used by `native/vst3-host`. The SDK is downloaded only at desktop-build time; its required copyright and license notices must accompany every installer that includes the compiled host.

No audio codec is downloaded at runtime. The project must retain a verified local encoder and complete file-level validation before calling MP3 export production-ready.
