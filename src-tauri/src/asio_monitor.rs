use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, Write},
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

const MAX_WASAPI_BACKING_BYTES: u64 = 512 * 1024 * 1024;
const MAX_WASAPI_CHUNK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct WasapiBacking(Mutex<Option<BackingUpload>>);

struct BackingUpload {
    id: String,
    file: File,
    received: u64,
    expected: u64,
}

#[tauri::command]
pub async fn begin_wasapi_backing(app: AppHandle, id: String, bytes: u64) -> Result<(), String> {
    if id.len() != 36 || bytes == 0 || bytes % 8 != 0 || bytes > MAX_WASAPI_BACKING_BYTES {
        return Err("Tamanho da base WASAPI inválido.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WasapiBacking>();
        let mut slot = state.0.lock().map_err(|_| "Base WASAPI indisponível.")?;
        let file = tempfile::tempfile().map_err(|error| format!("Não foi possível criar a base temporária: {error}"))?;
        *slot = Some(BackingUpload { id, file, received: 0, expected: bytes });
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn append_wasapi_backing(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |key: &str| request.headers().get(key).and_then(|value| value.to_str().ok());
    let id = header("x-backing-id").filter(|id| id.len() == 36).ok_or("Identificador da base inválido.")?.to_owned();
    let offset = header("x-backing-offset").and_then(|value| value.parse::<u64>().ok()).ok_or("Posição PCM inválida.")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("PCM inválido.".into()); };
    if bytes.is_empty() || bytes.len() % 8 != 0 || bytes.len() > MAX_WASAPI_CHUNK_BYTES {
        return Err("Bloco PCM inválido.".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WasapiBacking>();
        let mut slot = state.0.lock().map_err(|_| "Base WASAPI indisponível.")?;
        let upload = slot.as_mut().filter(|upload| upload.id == id).ok_or("A base WASAPI não está aberta.")?;
        if offset != upload.received || bytes.len() as u64 > upload.expected - upload.received {
            return Err("Bloco PCM fora da sequência.".into());
        }
        if let Err(error) = upload.file.write_all(&bytes) {
            *slot = None;
            return Err(format!("Falha ao escrever a base temporária: {error}"));
        }
        upload.received += bytes.len() as u64;
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn discard_wasapi_backing(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<WasapiBacking>();
    let mut slot = state.0.lock().map_err(|_| "Base WASAPI indisponível.")?;
    if slot.as_ref().is_some_and(|upload| upload.id == id) {
        *slot = None;
    }
    Ok(())
}

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
    wasapi: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    wasapi: Option<WasapiCaptureStats>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasapiCaptureStats {
    capture_discontinuities: u32,
    capture_missing_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    rendered_backing_frames: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    empty_output_buffers: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    monitor_dropped_frames: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    monitor_underruns: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    monitor_priming_frames: Option<u32>,
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
        CapturePacket { samples, ended, error: self.error.clone(), wasapi: None }
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
    start_monitor(app, frames, sample_rate, input, output, capture, dry_return, channels, backend, input_device_id, None).await
}

struct WasapiDuplex {
    output_device: String,
    output_period: u32,
    output_rate: u32,
    backing: BackingUpload,
}

#[tauri::command]
pub async fn start_wasapi_duplex(
    app: AppHandle, backing_id: String, input_device_id: String, frames: u32, sample_rate: u32,
    input: u32, channels: u32, output_device: String, output_period: u32, output_rate: u32, dry_return: bool,
) -> Result<MonitorInfo, String> {
    if output_device.is_empty() || output_device.len() > 2048
        || output_period > 32768 || !(8000..=192000).contains(&output_rate) {
        return Err("Configuração incompatível com a saída WASAPI.".into());
    }
    let backing = {
        let state = app.state::<WasapiBacking>();
        let mut slot = state.0.lock().map_err(|_| "Base WASAPI indisponível.")?;
        if !slot.as_ref().is_some_and(|upload| upload.id == backing_id && upload.received == upload.expected) {
            return Err("A base WASAPI chegou incompleta.".into());
        }
        slot.take().expect("base WASAPI verificada")
    };
    let duplex = WasapiDuplex { output_device, output_period, output_rate, backing };
    start_monitor(app, frames, sample_rate, input, 0, Some(true), Some(dry_return), Some(channels),
        Some("wasapi".into()), Some(input_device_id), Some(duplex)).await
}

async fn start_monitor(
    app: AppHandle, frames: u32, sample_rate: u32, input: u32, output: u32,
    capture: Option<bool>, dry_return: Option<bool>, channels: Option<u32>,
    backend: Option<String>, input_device_id: Option<String>, duplex: Option<WasapiDuplex>,
) -> Result<MonitorInfo, String> {
    let capturing = capture.unwrap_or(false);
    let channels = channels.unwrap_or(1);
    if !cfg!(windows) || frames > 32768 || !(8000..=192000).contains(&sample_rate) || input > 255 || output > 255 || !(1..=2).contains(&channels) {
        return Err("Configuração ASIO inválida.".into());
    }
    let wasapi = backend.as_deref() == Some("wasapi");
    let path = if wasapi {
        if !capturing || (dry_return == Some(true) && duplex.is_none()) || !input_device_id.as_ref().is_some_and(|id| !id.is_empty() && id.len() <= 2048) {
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
            command.args([if duplex.is_some() { "--duplex" } else { "--capture" }.to_owned(),
                input_device_id.unwrap_or_default(), frames.to_string(), input.to_string(), channels.to_string()]);
            if let Some(output) = &duplex {
                command.args([output.output_device.clone(), output.output_period.to_string(), output.output_rate.to_string(),
                    if dry_return == Some(true) { "1" } else { "0" }.to_owned(), (output.backing.expected / 8).to_string()]);
            }
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
        let mut session = Session { child, diagnostics, capture, capture_done, wasapi };
        let sent = duplex.map(|mut output| {
            let mut stdin = session.child.stdin.take().expect("stdin redirecionado");
            let (sender, receiver) = mpsc::channel();
            thread::spawn(move || {
                let result = output.backing.file.rewind().and_then(|()| std::io::copy(&mut output.backing.file, &mut stdin))
                    .and_then(|count| if count == output.backing.expected { Ok(()) } else {
                        Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "base WASAPI incompleta"))
                    });
                let _ = sender.send((stdin, result));
            });
            receiver
        });
        let info = match ready_rx.recv_timeout(Duration::from_secs(if sent.is_some() { 30 } else { 5 })) {
            Ok(Ok(info)) if info.callbacks > 0 && info.frames > 0 && info.channels == channels && info.sample_rate.is_finite() && info.sample_rate > 0.0 => info,
            _ => return Err(session.error(if wasapi { "O WASAPI não confirmou blocos de áudio." } else { "O ASIO4ALL não confirmou blocos de áudio." })),
        };
        if let Some(sent) = sent {
            let (stdin, result) = sent.recv_timeout(Duration::from_millis(500)).map_err(|_| "A saída WASAPI não recebeu a base.")?;
            session.child.stdin = Some(stdin);
            result.map_err(|error| format!("Falha ao enviar a base WASAPI: {error}"))?;
        }
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
        } else if stopped && drained && session.wasapi {
            packet.wasapi = session.diagnostics.recv_timeout(Duration::from_millis(150)).ok().and_then(|message| {
                message.lines().find_map(|line| {
                    serde_json::from_str(line.strip_prefix("VALE_WASAPI_STATS ")?).ok()
                })
            });
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
