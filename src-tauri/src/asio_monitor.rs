use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Monitor(Mutex<Option<Session>>);

struct Session {
    child: Child,
    diagnostics: mpsc::Receiver<String>,
    capture: Option<Arc<Mutex<CaptureQueue>>>,
    capture_done: mpsc::Receiver<()>,
}

#[derive(Default)]
struct CaptureQueue {
    bytes: VecDeque<u8>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct CapturePacket {
    samples: Vec<f32>,
    ended: bool,
    error: Option<String>,
}

fn read_capture(reader: &mut impl Read, capture: &Mutex<CaptureQueue>) {
    let mut block = [0u8; 16384];
    loop {
        let next = reader.read(&mut block);
        let Ok(mut queue) = capture.lock() else { return };
        match next {
            Ok(0) => return,
            Ok(count) if queue.bytes.len() + count <= 1024 * 1024 && queue.error.is_none() => {
                queue.bytes.extend(&block[..count]);
            }
            Ok(_) => { queue.error.get_or_insert("A fila de captura ASIO excedeu o limite.".into()); }
            Err(error) => {
                queue.error.get_or_insert(format!("Falha na leitura da captura ASIO: {error}"));
                return;
            }
        }
    }
}

impl CaptureQueue {
    fn drain(&mut self, limit: usize, ended: bool) -> CapturePacket {
        if ended && self.bytes.len() % 4 != 0 {
            self.error.get_or_insert("O driver encerrou com um frame PCM incompleto.".into());
        }
        let count = (self.bytes.len() / 4).min(limit);
        let samples = (0..count)
            .map(|_| f32::from_le_bytes(std::array::from_fn(|_| self.bytes.pop_front().unwrap())))
            .collect();
        CapturePacket { samples, ended, error: self.error.clone() }
    }
}

impl Session {
    fn stop(&mut self) -> bool {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_millis(450);
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                return status.success();
            }
            thread::sleep(Duration::from_millis(15));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        false
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
        let _ = self.stop();
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
    capture: Option<bool>,
    dry_return: Option<bool>,
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
        let capturing = capture.unwrap_or(false);
        command
            .args([
                if capturing { "--capture" } else { "--monitor" }.to_owned(),
                "ASIO4ALL v2".to_owned(),
                frames.to_string(),
                sample_rate.to_string(),
                input.to_string(),
                output.to_string(),
            ]);
        if capturing { command.arg(if dry_return.unwrap_or(false) { "1" } else { "0" }); }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Falha ao abrir o host ASIO: {error}"))?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let (error_tx, diagnostics) = mpsc::channel();
        let (capture_done_tx, capture_done) = mpsc::channel();
        let capture = capturing.then(|| Arc::new(Mutex::new(CaptureQueue::default())));
        let stream_capture = capture.clone();
        let stdout = child.stdout.take().expect("stdout redirecionado");
        let stderr = child.stderr.take().expect("stderr redirecionado");
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout).take(8192);
            let mut response = String::new();
            while matches!(reader.read_line(&mut response), Ok(count) if count > 0) {
                if let Some(payload) = response.strip_prefix("VALE_ASIO_READY ") {
                    let _ = ready_tx.send(serde_json::from_str::<MonitorInfo>(payload));
                    if let Some(queue) = stream_capture {
                        read_capture(&mut reader.into_inner(), &queue);
                    }
                    break;
                }
                response.clear();
            }
            let _ = capture_done_tx.send(());
        });
        thread::spawn(move || {
            let mut message = String::new();
            let _ = stderr.take(8192).read_to_string(&mut message);
            let _ = error_tx.send(message.trim().to_owned());
        });
        let session = Session { child, diagnostics, capture, capture_done };
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
pub fn read_asio_capture(app: AppHandle) -> Result<CapturePacket, String> {
    let state = app.state::<Monitor>();
    let mut current = state.0.lock().map_err(|_| "Estado ASIO indisponível.")?;
    let session = current.as_mut().ok_or("Nenhuma captura ASIO está aberta.")?;
    let ended = session.child.try_wait().map_err(|error| error.to_string())?.is_some();
    let capture = session.capture.as_ref().ok_or("O host ASIO está no modo de retorno.")?;
    let mut queue = capture.lock().map_err(|_| "Fila de captura ASIO indisponível.")?;
    // The stdout reader can still have buffered bytes after child exit.
    let mut packet = queue.drain(32768, false);
    packet.ended = ended;
    Ok(packet)
}

#[tauri::command]
pub async fn finish_asio_capture(app: AppHandle) -> Result<CapturePacket, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Monitor>();
        let mut current = state.0.lock().map_err(|_| "Estado ASIO indisponível.")?;
        if !current.as_ref().is_some_and(|session| session.capture.is_some()) {
            return Err("Nenhuma captura ASIO está aberta.".into());
        }
        let mut session = current.take().expect("captura verificada");
        let stopped = session.stop();
        let drained = session.capture_done.recv_timeout(Duration::from_millis(500)).is_ok();
        let capture = session.capture.as_ref().expect("fila de captura verificada");
        let mut queue = capture.lock().map_err(|_| "Fila de captura ASIO indisponível.")?;
        let mut packet = queue.drain(usize::MAX, true);
        if packet.error.is_none() && (!stopped || !drained) {
            packet.error = Some(session.error("A captura ASIO não foi encerrada normalmente."));
        }
        Ok(packet)
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
