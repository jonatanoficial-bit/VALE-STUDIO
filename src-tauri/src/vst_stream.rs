use super::host_binary;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager,
};

#[derive(Default)]
pub struct Streams(Mutex<HashMap<String, Arc<Stream>>>);

struct Stream {
    child: Mutex<Child>,
    pipe: Mutex<(Option<ChildStdin>, ChildStdout, bool)>,
    audio_bytes: usize,
}

impl Stream {
    fn finish(&self) {
        if let Ok(mut pipe) = self.pipe.try_lock() {
            pipe.0.take();
        } else {
            self.kill();
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            for _ in 0..20 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
        self.kill();
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn process(&self, block: &[u8]) -> Result<Vec<u8>, String> {
        let count_bytes = block
            .get(self.audio_bytes..self.audio_bytes + 4)
            .ok_or("Bloco de áudio incompleto.")?;
        let events = (u32::from_le_bytes(count_bytes.try_into().unwrap()) & 0x7fff_ffff) as usize;
        if events > 1024 || block.len() != self.audio_bytes + 4 + events * 16 {
            return Err("Bloco de áudio inválido.".into());
        }
        let mut pipe = self.pipe.lock().map_err(|_| "Sessão VST3 interrompida.")?;
        let (input, output, ready) = &mut *pipe;
        let mut render = vec![0; self.audio_bytes];
        if !*ready {
            let mut marker = [0u8; 1];
            output.read_exact(&mut marker).map_err(|_| "O plug-in não iniciou.")?;
            if marker != [1] {
                return Err("Resposta inválida do host VST3.".into());
            }
            *ready = true;
        }
        input.as_mut().ok_or("Sessão encerrada.")?.write_all(block).map_err(|_| "Falha ao enviar áudio ao plug-in.")?;
        output.read_exact(&mut render).map_err(|_| "O plug-in interrompeu o áudio.")?;
        Ok(render)
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.kill();
    }
}

#[tauri::command]
pub fn open_vst_stream(
    app: AppHandle,
    stream_id: String,
    insert_id: String,
    bundle_path: String,
    class_id: String,
    frames: usize,
    sample_rate: u32,
    bpm: f64,
) -> Result<(), String> {
    if !matches!(frames, 256 | 512 | 1024 | 2048 | 4096)
        || !(8000..=192000).contains(&sample_rate)
        || !(20.0..=400.0).contains(&bpm)
        || stream_id.len() != 36
        || insert_id.len() != 36
        || !insert_id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        || class_id.len() != 32
        || !class_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Configuração de áudio VST3 inválida.".into());
    }
    let path = PathBuf::from(bundle_path);
    if !path.is_absolute() || !path.exists() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("vst3")) {
        return Err("Módulo VST3 indisponível.".into());
    }
    let state = app.state::<Streams>();
    let mut sessions = state.0.lock().map_err(|_| "Host VST3 indisponível.")?;
    if sessions.len() >= 32 || sessions.contains_key(&stream_id) {
        return Err("Limite de instâncias do host VST3 atingido.".into());
    }
    let state_directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("vst-state");
    std::fs::create_dir_all(&state_directory).map_err(|error| error.to_string())?;
    let state_path = state_directory.join(format!("{insert_id}-{class_id}.bin"));
    let mut command = Command::new(host_binary(&app)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .arg("--stream")
        .arg(path)
        .args([class_id, frames.to_string(), sample_rate.to_string(), bpm.to_string()])
        .arg(state_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let input = child.stdin.take().expect("stdin configurado como pipe");
    let output = child.stdout.take().expect("stdout configurado como pipe");
    sessions.insert(stream_id, Arc::new(Stream {
        child: Mutex::new(child),
        pipe: Mutex::new((Some(input), output, false)),
        audio_bytes: frames * 8,
    }));
    Ok(())
}

#[tauri::command]
pub async fn process_vst_stream(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("O áudio VST3 exige um bloco binário.".into());
    };
    if bytes.len() > 36 + 4096 * 8 + 4 + 1024 * 16 {
        return Err("Bloco de áudio acima do limite.".into());
    }
    let id = bytes.get(..36).and_then(|value| std::str::from_utf8(value).ok()).ok_or("Sessão inválida.")?;
    let stream = app.state::<Streams>().0.lock().map_err(|_| "Host VST3 indisponível.")?
        .get(id).cloned().ok_or("Sessão encerrada.")?;
    let block = bytes[36..].to_vec();
    tauri::async_runtime::spawn_blocking(move || stream.process(&block))
        .await
        .map_err(|error| error.to_string())?
        .map(Response::new)
}

#[tauri::command]
pub async fn close_vst_stream(app: AppHandle, stream_id: String) {
    let state = app.state::<Streams>();
    let stream = state.0.lock().ok().and_then(|mut sessions| sessions.remove(&stream_id));
    if let Some(stream) = stream {
        let _ = tauri::async_runtime::spawn_blocking(move || stream.finish()).await;
    }
}
