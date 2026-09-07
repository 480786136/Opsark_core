use crate::ssh::connect_ssh;
use serde::Serialize;
use sha2::{Digest, Sha256};
use ssh2::RenameFlags;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const TRANSFER_CHUNK_SIZE: usize = 64 * 1024;
const MAX_TRANSFER_SIZE: usize = 20 * 1024 * 1024;
const CANCELLED_ERROR: &str = "SFTP_TRANSFER_CANCELLED";

#[derive(Clone, Default)]
pub(crate) struct SftpTransferManager {
    transfers: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTransferEvent {
    transfer_id: String,
    direction: String,
    transferred_bytes: u64,
    total_bytes: u64,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerTransferResult {
    source_path: String,
    target_path: String,
    transferred_bytes: u64,
    sha256: String,
}

impl SftpTransferManager {
    fn start(&self, transfer_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut transfers = self.transfers.lock().map_err(|_| "SFTP 传输状态锁异常")?;
        if transfers.contains_key(transfer_id) {
            return Err("传输任务 ID 已存在".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        transfers.insert(transfer_id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    fn finish(&self, transfer_id: &str) {
        if let Ok(mut transfers) = self.transfers.lock() {
            transfers.remove(transfer_id);
        }
    }

    fn cancel(&self, transfer_id: &str) -> Result<bool, String> {
        let transfers = self.transfers.lock().map_err(|_| "SFTP 传输状态锁异常")?;
        let Some(cancelled) = transfers.get(transfer_id) else {
            return Ok(false);
        };
        cancelled.store(true, Ordering::Release);
        Ok(true)
    }
}

fn emit_progress(
    app: &AppHandle,
    transfer_id: &str,
    direction: &str,
    transferred_bytes: u64,
    total_bytes: u64,
    status: &str,
) {
    let _ = app.emit(
        "sftp-transfer-progress",
        SftpTransferEvent {
            transfer_id: transfer_id.to_string(),
            direction: direction.to_string(),
            transferred_bytes,
            total_bytes,
            status: status.to_string(),
        },
    );
}

fn ensure_transfer_size(size: usize) -> Result<(), String> {
    if size > MAX_TRANSFER_SIZE {
        return Err("当前图形传输上限为 20 MB".into());
    }
    Ok(())
}

struct TransferRequest<'a> {
    app: &'a AppHandle,
    transfer_id: &'a str,
    host: &'a str,
    port: u16,
    username: &'a str,
    password: &'a str,
    path: &'a str,
    cancelled: &'a AtomicBool,
}

fn upload(request: TransferRequest<'_>, data: &[u8]) -> Result<(), String> {
    ensure_transfer_size(data.len())?;
    let sftp = connect_ssh(
        request.host,
        request.port,
        request.username,
        request.password,
    )?
    .sftp()
    .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    let mut remote_file = sftp
        .create(Path::new(request.path))
        .map_err(|error| format!("创建远程文件失败：{error}"))?;
    let total = data.len() as u64;
    let mut transferred = 0_u64;

    for chunk in data.chunks(TRANSFER_CHUNK_SIZE) {
        if request.cancelled.load(Ordering::Acquire) {
            drop(remote_file);
            let _ = sftp.unlink(Path::new(request.path));
            return Err(CANCELLED_ERROR.into());
        }
        remote_file
            .write_all(chunk)
            .map_err(|error| format!("上传写入失败：{error}"))?;
        transferred += chunk.len() as u64;
        emit_progress(
            request.app,
            request.transfer_id,
            "upload",
            transferred,
            total,
            "running",
        );
    }
    remote_file
        .flush()
        .map_err(|error| format!("上传刷新失败：{error}"))?;
    emit_progress(
        request.app,
        request.transfer_id,
        "upload",
        total,
        total,
        "completed",
    );
    Ok(())
}

fn download(request: TransferRequest<'_>) -> Result<Vec<u8>, String> {
    let sftp = connect_ssh(
        request.host,
        request.port,
        request.username,
        request.password,
    )?
    .sftp()
    .map_err(|error| format!("SFTP 会话创建失败：{error}"))?;
    let mut remote_file = sftp
        .open(Path::new(request.path))
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let total = remote_file
        .stat()
        .map_err(|error| format!("读取远程文件信息失败：{error}"))?
        .size
        .unwrap_or(0);
    ensure_transfer_size(total as usize)?;
    let mut result = Vec::with_capacity(total as usize);
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];

    loop {
        if request.cancelled.load(Ordering::Acquire) {
            return Err(CANCELLED_ERROR.into());
        }
        let size = remote_file
            .read(&mut buffer)
            .map_err(|error| format!("下载读取失败：{error}"))?;
        if size == 0 {
            break;
        }
        result.extend_from_slice(&buffer[..size]);
        emit_progress(
            request.app,
            request.transfer_id,
            "download",
            result.len() as u64,
            total,
            "running",
        );
    }
    emit_progress(
        request.app,
        request.transfer_id,
        "download",
        result.len() as u64,
        total,
        "completed",
    );
    Ok(result)
}

#[tauri::command(async)]
pub(crate) async fn upload_sftp_transfer(
    app: AppHandle,
    manager: State<'_, SftpTransferManager>,
    transfer_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let cancelled = manager.start(&transfer_id)?;
    let transfer_manager = manager.inner().clone();
    let task_id = transfer_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        upload(
            TransferRequest {
                app: &app,
                transfer_id: &transfer_id,
                host: &host,
                port,
                username: &username,
                password: &password,
                path: &path,
                cancelled: &cancelled,
            },
            &data,
        )
    })
    .await
    .map_err(|error| format!("SFTP 上传任务异常：{error}"))?;
    transfer_manager.finish(&task_id);
    result
}

#[tauri::command(async)]
pub(crate) async fn download_sftp_transfer(
    app: AppHandle,
    manager: State<'_, SftpTransferManager>,
    transfer_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let cancelled = manager.start(&transfer_id)?;
    let transfer_manager = manager.inner().clone();
    let task_id = transfer_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download(TransferRequest {
            app: &app,
            transfer_id: &transfer_id,
            host: &host,
            port,
            username: &username,
            password: &password,
            path: &path,
            cancelled: &cancelled,
        })
    })
    .await
    .map_err(|error| format!("SFTP 下载任务异常：{error}"))?;
    transfer_manager.finish(&task_id);
    result
}

#[allow(clippy::too_many_arguments)]
fn relay_between_servers(
    app: &AppHandle,
    transfer_id: &str,
    source_host: &str,
    source_port: u16,
    source_username: &str,
    source_password: &str,
    source_path: &str,
    target_host: &str,
    target_port: u16,
    target_username: &str,
    target_password: &str,
    target_path: &str,
    overwrite: bool,
    cancelled: &AtomicBool,
) -> Result<ServerTransferResult, String> {
    let source_sftp = connect_ssh(source_host, source_port, source_username, source_password)?
        .sftp()
        .map_err(|error| format!("源服务器 SFTP 会话创建失败：{error}"))?;
    let target_sftp = connect_ssh(target_host, target_port, target_username, target_password)?
        .sftp()
        .map_err(|error| format!("目标服务器 SFTP 会话创建失败：{error}"))?;
    let mut source = source_sftp
        .open(Path::new(source_path))
        .map_err(|error| format!("打开源文件失败：{error}"))?;
    let total = source
        .stat()
        .map_err(|error| format!("读取源文件信息失败：{error}"))?
        .size
        .unwrap_or(0);
    if target_sftp.stat(Path::new(target_path)).is_ok() && !overwrite {
        return Err(format!("目标文件已存在，未授权覆盖：{target_path}"));
    }
    let safe_id: String = transfer_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    let temporary_path = format!(
        "{target_path}.opsark-part-{}",
        &safe_id[..safe_id.len().min(24)]
    );
    let mut target = target_sftp
        .create(Path::new(&temporary_path))
        .map_err(|error| format!("创建目标临时文件失败：{error}"))?;
    let result = (|| {
        let mut source_hash = Sha256::new();
        let mut transferred = 0_u64;
        let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(CANCELLED_ERROR.into());
            }
            let size = source
                .read(&mut buffer)
                .map_err(|error| format!("读取源文件失败：{error}"))?;
            if size == 0 {
                break;
            }
            target
                .write_all(&buffer[..size])
                .map_err(|error| format!("写入目标文件失败：{error}"))?;
            source_hash.update(&buffer[..size]);
            transferred += size as u64;
            emit_progress(app, transfer_id, "server", transferred, total, "running");
        }
        target
            .flush()
            .map_err(|error| format!("刷新目标文件失败：{error}"))?;
        drop(target);

        let mut verify = target_sftp
            .open(Path::new(&temporary_path))
            .map_err(|error| format!("重新打开目标文件校验失败：{error}"))?;
        let mut target_hash = Sha256::new();
        loop {
            let size = verify
                .read(&mut buffer)
                .map_err(|error| format!("读取目标文件校验失败：{error}"))?;
            if size == 0 {
                break;
            }
            target_hash.update(&buffer[..size]);
        }
        let source_digest = source_hash.finalize();
        let target_digest = target_hash.finalize();
        if source_digest.as_slice() != target_digest.as_slice() {
            return Err("跨服务器传输 SHA-256 校验失败".into());
        }
        if overwrite && target_sftp.stat(Path::new(target_path)).is_ok() {
            target_sftp
                .unlink(Path::new(target_path))
                .map_err(|error| format!("移除目标旧文件失败：{error}"))?;
        }
        target_sftp
            .rename(
                Path::new(&temporary_path),
                Path::new(target_path),
                Some(RenameFlags::OVERWRITE | RenameFlags::ATOMIC),
            )
            .or_else(|_| {
                target_sftp.rename(Path::new(&temporary_path), Path::new(target_path), None)
            })
            .map_err(|error| format!("提交目标文件失败：{error}"))?;
        let sha256 = source_digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        emit_progress(app, transfer_id, "server", transferred, total, "completed");
        Ok(ServerTransferResult {
            source_path: source_path.into(),
            target_path: target_path.into(),
            transferred_bytes: transferred,
            sha256,
        })
    })();
    if result.is_err() {
        let _ = target_sftp.unlink(Path::new(&temporary_path));
    }
    result
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn transfer_sftp_between_servers(
    app: AppHandle,
    manager: State<'_, SftpTransferManager>,
    transfer_id: String,
    source_host: String,
    source_port: u16,
    source_username: String,
    source_password: String,
    source_path: String,
    target_host: String,
    target_port: u16,
    target_username: String,
    target_password: String,
    target_path: String,
    overwrite: bool,
) -> Result<ServerTransferResult, String> {
    let cancelled = manager.start(&transfer_id)?;
    let transfer_manager = manager.inner().clone();
    let task_id = transfer_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        relay_between_servers(
            &app,
            &transfer_id,
            &source_host,
            source_port,
            &source_username,
            &source_password,
            &source_path,
            &target_host,
            target_port,
            &target_username,
            &target_password,
            &target_path,
            overwrite,
            &cancelled,
        )
    })
    .await
    .map_err(|error| format!("跨服务器传输任务异常：{error}"))?;
    transfer_manager.finish(&task_id);
    result
}

#[tauri::command]
pub(crate) fn cancel_sftp_transfer(
    manager: State<'_, SftpTransferManager>,
    transfer_id: String,
) -> Result<bool, String> {
    manager.cancel(&transfer_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_cancels_and_finishes_transfers() {
        let manager = SftpTransferManager::default();
        let cancelled = manager.start("transfer-1").unwrap();
        assert!(manager.start("transfer-1").is_err());
        assert!(manager.cancel("transfer-1").unwrap());
        assert!(cancelled.load(Ordering::Acquire));
        manager.finish("transfer-1");
        assert!(!manager.cancel("transfer-1").unwrap());
    }

    #[test]
    fn enforces_the_graphical_transfer_limit() {
        assert!(ensure_transfer_size(MAX_TRANSFER_SIZE).is_ok());
        assert!(ensure_transfer_size(MAX_TRANSFER_SIZE + 1).is_err());
    }
}
