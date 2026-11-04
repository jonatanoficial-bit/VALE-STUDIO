use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

const SCAN_TIMEOUT: Duration = Duration::from_secs(25);

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
}

#[derive(Serialize, Deserialize)]
struct Vst3ScanResult {
    plugins: Vec<Vst3Plugin>,
    errors: Vec<String>,
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

#[tauri::command]
fn scan_vst3(app: AppHandle, directory: String) -> Result<Vst3ScanResult, String> {
    let directory = PathBuf::from(directory)
        .canonicalize()
        .map_err(|_| "A pasta escolhida não existe ou não pode ser aberta.".to_string())?;
    if !directory.is_dir() {
        return Err("Escolha uma pasta, não um arquivo.".into());
    }

    let mut child = Command::new(host_binary(&app)?)
        .arg("--scan")
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Não foi possível iniciar o scanner VST3: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|error| format!("Falha ao acompanhar o scanner VST3: {error}"))? {
            Some(_) => break,
            None if started.elapsed() >= SCAN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("O scanner VST3 excedeu 25 segundos e foi interrompido. O plug-in problemático não foi carregado no Vale Studio.".into());
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Não foi possível ler a resposta do scanner VST3: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() { "O scanner VST3 terminou com erro.".into() } else { message });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "O scanner VST3 retornou uma resposta inválida.".into())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![desktop_runtime, pick_vst3_directory, scan_vst3])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar Vale Studio Desktop");
}
