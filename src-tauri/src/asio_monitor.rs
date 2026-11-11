use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Monitor(Mutex<Option<Session>>);

#[derive(Default)]
pub struct WasapiOutput(Mutex<Option<Child>>);

impl Drop for WasapiOutput {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

struct Session {
    child: Child,
    diagnostics: mpsc::Receiver<String>,
    capture: Option<Arc<Mutex<CaptureQueue>>>,
    capture_done: mpsc::Receiver<()>,
}

struct CaptureQueue {
    bytes: VecDeque<u8>,
    error: Option<String>,
    channels: usize,
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
        let frame_size = 4 * self.channels;
        if ended && self.bytes.len() % frame_size != 0 {
            self.error.get_or_insert("O driver encerrou com um frame PCM incompleto.".into());
        }
        let count = (self.bytes.len() / frame_size).min(limit) * self.channels;
        let samples = (0..count)
            .map(|_| f32::from_le_bytes(std::array::from_fn(|_| self.bytes.pop_front().unwrap())))
            .collect();
        CapturePacket { samples, ended, error: self.error.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_packets_keep_frames_intact_across_pipe_reads() {
        let mut queue = CaptureQueue { bytes: VecDeque::new(), error: None, channels: 2 };
        queue.bytes.extend(0.25_f32.to_le_bytes());
        assert!(queue.drain(1, false).samples.is_empty());

        queue.bytes.extend((-0.5_f32).to_le_bytes());
        queue.bytes.extend(0.75_f32.to_le_bytes());
        assert_eq!(queue.drain(1, false).samples, [0.25, -0.5]);
        let tail = queue.drain(usize::MAX, true);
        assert!(tail.samples.is_empty());
        assert!(tail.error.is_some());
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
    #[serde(skip_serializing_if = "Option::is_none")]
    buffer_frames: Option<u32>,
    channels: u32,
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

fn wasapi_host(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app.path().resource_dir().ok().map(|dir| dir.join("wasapi-host.exe"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native/wasapi-host/dist/wasapi-host.exe");
    packaged.into_iter().chain([development]).find(|path| path.is_file())
        .ok_or_else(|| "Host WASAPI indisponível. Prepare os binários do desktop.".into())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiDevice {
    id: String,
    name: String,
    flow: String,
    sample_rate: u32,
    channels: u32,
    standard: u32,
    fundamental: u32,
    minimum: u32,
    maximum: u32,
}

#[tauri::command]
pub async fn wasapi_devices(app: AppHandle) -> Result<Vec<WasapiDevice>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(wasapi_host(&app)?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.arg("--list").stdin(Stdio::null()).stdout(Stdio::piped())
            .stderr(Stdio::piped()).spawn().map_err(|error| format!("Falha ao listar dispositivos WASAPI: {error}"))?;
        let stdout = child.stdout.take().expect("stdout redirecionado");
        let reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.take(128 * 1024).read_to_end(&mut bytes).map(|_| bytes)
        });
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed() < Duration::from_secs(5) => thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("O Windows não respondeu à consulta de dispositivos WASAPI.".into());
                }
            }
        }
        let output = child.wait_with_output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        let bytes = reader.join().map_err(|_| "Falha na leitura da lista de dispositivos.")?
            .map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|error| format!("Lista WASAPI inválida: {error}"))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn play_wasapi_pcm(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let argument = |key: &str| request.headers().get(key).and_then(|value| value.to_str().ok());
    let device = argument("x-device-id").filter(|id| !id.is_empty() && id.len() <= 2048)
        .ok_or("Escolha um dispositivo de saída WASAPI.")?.to_owned();
    let period = argument("x-period").and_then(|value| value.parse::<u32>().ok()).filter(|value| *value <= 32768)
        .ok_or("Período WASAPI inválido.")?;
    let rate = argument("x-sample-rate").and_then(|value| value.parse::<u32>().ok()).filter(|value| (8000..=192000).contains(value))
        .ok_or("Taxa WASAPI inválida.")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("PCM inválido.".into()); };
    if bytes.is_empty() || bytes.len() % 8 != 0 || bytes.len() > 192 * 1024 * 1024 {
        return Err("Tamanho PCM incompatível com a saída WASAPI.".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WasapiOutput>();
        let mut slot = state.0.lock().map_err(|_| "Saída WASAPI indisponível.")?;
        if slot.is_some() {
            return Err("Encerre a reprodução WASAPI antes de abrir outra.".into());
        }
        let mut command = Command::new(wasapi_host(&app)?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.args(["--play".to_owned(), device, period.to_string(), rate.to_string(), (bytes.len() / 8).to_string()])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped())
            .spawn().map_err(|error| format!("Falha ao abrir a saída WASAPI: {error}"))?;
        let mut stdin = child.stdin.take().expect("stdin redirecionado");
        *slot = Some(child);
        drop(slot);
        stdin.write_all(&bytes).map_err(|error| format!("Falha ao enviar a mixagem para a saída WASAPI: {error}"))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn wasapi_output_running(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<WasapiOutput>();
    let mut slot = state.0.lock().map_err(|_| "Saída WASAPI indisponível.")?;
    let Some(child) = slot.as_mut() else { return Ok(false); };
    let Some(status) = child.try_wait().map_err(|error| error.to_string())? else { return Ok(true); };
    let mut child = slot.take().expect("processo WASAPI verificado");
    if !status.success() {
        let mut reason = String::new();
        if let Some(stderr) = child.stderr.take() { let _ = stderr.take(8192).read_to_string(&mut reason); }
        return Err(if reason.is_empty() { "A saída WASAPI foi interrompida.".into() } else { reason.trim().into() });
    }
    Ok(false)
}

#[tauri::command]
pub async fn stop_wasapi_output(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WasapiOutput>();
        let mut slot = state.0.lock().map_err(|_| "Saída WASAPI indisponível.")?;
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
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
    channels: Option<u32>,
    backend: Option<String>,
    input_device_id: Option<String>,
) -> Result<MonitorInfo, String> {
    let capturing = capture.unwrap_or(false);
    let channels = channels.unwrap_or(1);
    if !cfg!(windows) || frames > 32768 || !(8000..=192000).contains(&sample_rate) || input > 255 || output > 255 || !(1..=2).contains(&channels) {
        return Err("Configuração ASIO inválida.".into());
    }
    let wasapi = backend.as_deref() == Some("wasapi");
    let path = if wasapi {
        if !capturing || dry_return == Some(true) || !input_device_id.as_ref().is_some_and(|id| !id.is_empty() && id.len() <= 2048) {
            return Err("Escolha um dispositivo para a captura WASAPI.".into());
        }
        wasapi_host(&app)?
    } else {
        host_path().ok_or("O executável de desenvolvimento ASIO está indisponível.")?
    };
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
        if wasapi {
            command.args(["--capture".to_owned(), input_device_id.unwrap_or_default(), frames.to_string(), input.to_string(), channels.to_string()]);
        } else {
            command.args([
                if capturing { "--capture" } else { "--monitor" }.to_owned(),
                "ASIO4ALL v2".to_owned(),
                frames.to_string(),
                sample_rate.to_string(),
                input.to_string(),
                output.to_string(),
            ]);
            if capturing {
                command.arg(if dry_return.unwrap_or(false) { "1" } else { "0" });
            }
            command.arg(channels.to_string());
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Falha ao abrir o host ASIO: {error}"))?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let (error_tx, diagnostics) = mpsc::channel();
        let (capture_done_tx, capture_done) = mpsc::channel();
        let capture = capturing.then(|| Arc::new(Mutex::new(CaptureQueue {
            bytes: VecDeque::new(), error: None, channels: channels as usize,
        })));
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
            Ok(Ok(info)) if info.callbacks > 0 && info.frames > 0 && info.channels == channels && info.sample_rate.is_finite() && info.sample_rate > 0.0 => info,
            _ => return Err(session.error(if wasapi { "O WASAPI não confirmou blocos de áudio." } else { "O ASIO4ALL não confirmou blocos de áudio." })),
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
