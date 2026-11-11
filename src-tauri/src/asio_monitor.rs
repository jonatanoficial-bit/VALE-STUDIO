use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Monitor(Mutex<Option<Session>>);

struct Session {
    child: Child,
    diagnostics: mpsc::Receiver<String>,
}

impl Session {
    fn stop(&mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_millis(450);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(15));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn error(&self, fallback: &str) -> String {
        self.diagnostics
            .recv_timeout(Duration::from_millis(150))
            .ok()
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| fallback.to_owned())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    frames: u32,
    sample_rate: f64,
    input_latency: u32,
    output_latency: u32,
    callbacks: u32,
}

fn host_path() -> Option<PathBuf> {
    std::env::var_os("VALE_ASIO_HOST_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
}

#[tauri::command]
pub fn asio_monitor_available() -> bool {
    cfg!(windows) && host_path().is_some()
}

#[tauri::command]
pub async fn start_asio_monitor(
    app: AppHandle,
    frames: u32,
    sample_rate: u32,
    input: u32,
    output: u32,
) -> Result<MonitorInfo, String> {
    if !cfg!(windows) || frames > 32768 || !(8000..=192000).contains(&sample_rate) || input > 255 || output > 255 {
        return Err("Configuração ASIO inválida.".into());
    }
    let path = host_path().ok_or("O executável de desenvolvimento ASIO está indisponível.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Monitor>();
        let mut current = state.0.lock().map_err(|_| "Estado ASIO indisponível.")?;
        if current.is_some() {
            return Err("Já existe um retorno ASIO aberto.".into());
        }
        let mut command = Command::new(path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .args([
                "--monitor".to_owned(),
                "ASIO4ALL v2".to_owned(),
                frames.to_string(),
                sample_rate.to_string(),
                input.to_string(),
                output.to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Falha ao abrir o host ASIO: {error}"))?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let (error_tx, diagnostics) = mpsc::channel();
        let stdout = child.stdout.take().expect("stdout redirecionado");
        let stderr = child.stderr.take().expect("stderr redirecionado");
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout).take(8192);
            let mut response = String::new();
            while matches!(reader.read_line(&mut response), Ok(count) if count > 0) {
                if let Some(payload) = response.strip_prefix("VALE_ASIO_READY ") {
                    let _ = ready_tx.send(serde_json::from_str::<MonitorInfo>(payload));
                    break;
                }
                response.clear();
            }
        });
        thread::spawn(move || {
            let mut message = String::new();
            let _ = stderr.take(8192).read_to_string(&mut message);
            let _ = error_tx.send(message.trim().to_owned());
        });
        let session = Session { child, diagnostics };
        let info = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(info)) if info.callbacks > 0 && info.frames > 0 && info.sample_rate.is_finite() && info.sample_rate > 0.0 => info,
            _ => return Err(session.error("O ASIO4ALL não confirmou blocos de áudio.")),
        };
        *current = Some(session);
        Ok(info)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stop_asio_monitor(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Monitor>();
        let mut current = state.0.lock().map_err(|_| "Estado ASIO indisponível.")?;
        drop(current.take());
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn asio_monitor_running(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Monitor>();
        let mut current = state.0.lock().map_err(|_| "Estado ASIO indisponível.")?;
        let Some(session) = current.as_mut() else {
            return Ok(false);
        };
        if session.child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Ok(true);
        }
        let session = current.take().expect("sessão em execução");
        Err(session.error("O retorno ASIO foi interrompido."))
    })
    .await
    .map_err(|error| error.to_string())?
}
