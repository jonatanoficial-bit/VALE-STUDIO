use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Manager};
mod vst_stream;
mod asio_monitor;

const VST3_HOST_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntime {
    platform: String,
    vst3_scan_available: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vst3Plugin {
    bundle_path: String,
    class_id: String,
    name: String,
    vendor: String,
    version: String,
    kind: String,
}

#[derive(Serialize, Deserialize)]
struct Vst3ScanResult {
    plugins: Vec<Vst3Plugin>,
    errors: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Vst3ProbeResult {
    compatible: bool,
    message: String,
}

fn host_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("VALE_VST3_HOST_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err("VALE_VST3_HOST_PATH não aponta para um executável válido.".into());
    }

    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Não foi possível localizar os recursos do desktop: {error}"))?
        .join("vst3-host.exe");
    if resource.is_file() {
        return Ok(resource);
    }

    let development = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../native/vst3-host/dist/vst3-host.exe");
    if development.is_file() {
        return Ok(development);
    }

    Err("O host VST3 nativo não foi preparado. Execute `pnpm desktop:prepare` antes de abrir o desktop.".into())
}

#[tauri::command]
fn desktop_runtime(app: AppHandle) -> DesktopRuntime {
    DesktopRuntime {
        platform: std::env::consts::OS.into(),
        vst3_scan_available: host_binary(&app).is_ok(),
    }
}

#[tauri::command]
fn pick_vst3_directory() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Escolha a pasta que contém seus plug-ins VST3")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

fn run_vst3_host(app: &AppHandle, arguments: &[String], operation: &str) -> Result<Vec<u8>, String> {
    let mut command = Command::new(host_binary(app)?);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Não foi possível iniciar {operation} VST3: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|error| format!("Falha ao acompanhar {operation} VST3: {error}"))? {
            Some(_) => break,
            None if started.elapsed() >= VST3_HOST_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{operation} VST3 excedeu 25 segundos e foi interrompido. O plug-in problemático não foi carregado no Vale Studio."));
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Não foi possível ler a resposta de {operation} VST3: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() { format!("{operation} VST3 terminou com erro.") } else { message });
    }
    Ok(output.stdout)
}

fn scan_vst3_directories(app: &AppHandle, mut directories: Vec<PathBuf>) -> Vst3ScanResult {
    let mut result = Vst3ScanResult { plugins: Vec::new(), errors: Vec::new() };
    let mut modules = Vec::new();
    while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                result.errors.push(format!("{}: {error}", directory.display()));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    result.errors.push(format!("{}: {error}", directory.display()));
                    continue;
                }
            };
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("vst3")) {
                modules.push(path);
            } else if entry.file_type().is_ok_and(|kind| kind.is_dir() && !kind.is_symlink()) {
                directories.push(path);
            }
        }
    }
    modules.sort();
    modules.dedup();

    // Separate address spaces preserve the rest of the catalog if a module crashes.
    let next = std::sync::atomic::AtomicUsize::new(0);
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::scope(|scope| {
        for _ in 0..modules.len().min(4) {
            let sender = sender.clone();
            let modules = &modules;
            let next = &next;
            scope.spawn(move || {
                while let Some(path) = modules.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) {
                    let response = run_vst3_host(app, &["--scan".into(), path.to_string_lossy().into_owned()], "o scanner")
                        .and_then(|bytes| serde_json::from_slice::<Vst3ScanResult>(&bytes).map_err(|error| error.to_string()))
                        .map_err(|error| format!("{}: {error}", path.display()));
                    if sender.send(response).is_err() {
                        break;
                    }
                }
            });
        }
    });
    drop(sender);
    for response in receiver {
        match response {
            Ok(mut scanned) => {
                result.plugins.append(&mut scanned.plugins);
                result.errors.append(&mut scanned.errors);
            }
            Err(error) => result.errors.push(error),
        }
    }
    result.plugins.sort_by_cached_key(|plugin| plugin.name.to_lowercase());
    result
}

#[tauri::command]
async fn scan_vst3(app: AppHandle, directory: String) -> Result<Vst3ScanResult, String> {
    let directory = PathBuf::from(directory)
        .canonicalize()
        .map_err(|_| "A pasta escolhida não existe ou não pode ser aberta.".to_string())?;
    if !directory.is_dir() {
        return Err("Escolha uma pasta, não um arquivo.".into());
    }

    tauri::async_runtime::spawn_blocking(move || scan_vst3_directories(&app, vec![directory]))
        .await
        .map_err(|error| format!("O scanner VST3 foi interrompido: {error}"))
}

fn default_vst3_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        directories.push(PathBuf::from(&program_files).join("Common Files").join("VST3"));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        directories.push(PathBuf::from(program_files_x86).join("Common Files").join("VST3"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        directories.push(PathBuf::from(local_app_data).join("Programs").join("Common").join("VST3"));
    }
    directories.into_iter().filter(|directory| directory.is_dir()).collect()
}

#[tauri::command]
async fn scan_default_vst3(app: AppHandle) -> Result<Vst3ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || scan_vst3_directories(&app, default_vst3_directories()))
        .await
        .map_err(|error| format!("O scanner VST3 foi interrompido: {error}"))
}

#[tauri::command]
fn probe_vst3(app: AppHandle, bundle_path: String, class_id: String) -> Result<Vst3ProbeResult, String> {
    let bundle_path = PathBuf::from(bundle_path)
        .canonicalize()
        .map_err(|_| "O módulo VST3 não existe ou não pode ser aberto.".to_string())?;
    if !bundle_path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("vst3")) {
        return Err("A qualificação aceita apenas módulos .vst3.".into());
    }
    if class_id.is_empty() || class_id.len() > 128 {
        return Err("O identificador da classe VST3 é inválido.".into());
    }
    let output = run_vst3_host(&app, &["--probe".into(), bundle_path.to_string_lossy().into_owned(), class_id], "a qualificação")?;
    serde_json::from_slice(&output)
        .map_err(|_| "A qualificação VST3 retornou uma resposta inválida.".into())
}

pub fn run() {
    tauri::Builder::default()
        .manage(vst_stream::Streams::default())
        .manage(asio_monitor::Monitor::default())
        .manage(asio_monitor::WasapiOutput::default())
        .invoke_handler(tauri::generate_handler![
            desktop_runtime, pick_vst3_directory, scan_vst3, scan_default_vst3, probe_vst3,
            vst_stream::open_vst_stream, vst_stream::process_vst_stream, vst_stream::close_vst_stream,
            asio_monitor::asio_monitor_available, asio_monitor::wasapi_devices, asio_monitor::start_asio_monitor, asio_monitor::start_wasapi_duplex,
            asio_monitor::stop_asio_monitor, asio_monitor::asio_monitor_running,
            asio_monitor::read_asio_capture, asio_monitor::finish_asio_capture,
            asio_monitor::play_wasapi_pcm, asio_monitor::wasapi_output_running, asio_monitor::stop_wasapi_output
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar Vale Studio Desktop");
}
