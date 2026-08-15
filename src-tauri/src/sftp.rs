use crate::ssh::connect_ssh;
use serde::Serialize;
use ssh2::Sftp;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_TRANSFER_SIZE: usize = 20 * 1024 * 1024;
const FILE_TYPE_MASK: u32 = 0o170000;
const DIRECTORY_TYPE: u32 = 0o040000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFileEntry {
    name: String,
    path: String,
    kind: String,
    size: String,
    modified: String,
}

fn open_sftp(host: &str, port: u16, username: &str, password: &str) -> Result<Sftp, String> {
    connect_ssh(host, port, username, password)?
        .sftp()
        .map_err(|error| format!("SFTP 会话创建失败：{error}"))
}

fn is_directory(permission: u32) -> bool {
    permission & FILE_TYPE_MASK == DIRECTORY_TYPE
}

fn format_file_size(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn map_directory_entry(
    entry_path: PathBuf,
    permission: u32,
    size: u64,
    modified: Option<u64>,
) -> Option<RemoteFileEntry> {
    let name = entry_path.file_name()?.to_string_lossy().to_string();
    if matches!(name.as_str(), "." | "..") {
        return None;
    }
    let directory = is_directory(permission);
    Some(RemoteFileEntry {
        name,
        path: entry_path.to_string_lossy().to_string(),
        kind: if directory { "directory" } else { "file" }.into(),
        size: if directory {
            "—".into()
        } else {
            format_file_size(size)
        },
        modified: modified
            .map(|value| value.to_string())
            .unwrap_or_else(|| "—".into()),
    })
}

fn sort_directory_entries(entries: &mut [RemoteFileEntry]) {
    entries.sort_by(|a, b| {
        let a_directory = a.kind == "directory";
        let b_directory = b.kind == "directory";
        b_directory
            .cmp(&a_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn validate_delete_path(path: &str) -> Result<(), String> {
    if path == "/" || path.trim().is_empty() {
        return Err("安全策略禁止删除根目录".into());
    }
    Ok(())
}

fn validate_download_size(size: u64) -> Result<(), String> {
    if size > MAX_TRANSFER_SIZE as u64 {
        return Err("首版下载限制为 20 MB，请使用终端或专业传输工具处理大文件".into());
    }
    Ok(())
}

fn validate_upload_size(size: usize) -> Result<(), String> {
    if size > MAX_TRANSFER_SIZE {
        return Err("首版上传限制为 20 MB".into());
    }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn list_sftp_directory(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let sftp = open_sftp(&host, port, &username, &password)?;
    let entries = sftp
        .readdir(Path::new(&path))
        .map_err(|error| format!("无法读取远程目录 {path}：{error}"))?;
    let mut result = entries
        .into_iter()
        .filter_map(|(entry_path, stat)| {
            map_directory_entry(
                entry_path,
                stat.perm.unwrap_or(0),
                stat.size.unwrap_or(0),
                stat.mtime,
            )
        })
        .collect::<Vec<_>>();
    sort_directory_entries(&mut result);
    Ok(result)
}

#[tauri::command(async)]
pub(crate) fn create_sftp_directory(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
) -> Result<(), String> {
    open_sftp(&host, port, &username, &password)?
        .mkdir(Path::new(&path), 0o755)
        .map_err(|error| format!("创建目录失败：{error}"))
}

#[tauri::command(async)]
pub(crate) fn rename_sftp_entry(
    host: String,
    port: u16,
    username: String,
    password: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    open_sftp(&host, port, &username, &password)?
        .rename(Path::new(&from_path), Path::new(&to_path), None)
        .map_err(|error| format!("重命名失败：{error}"))
}

#[tauri::command(async)]
pub(crate) fn delete_sftp_entry(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
    kind: String,
) -> Result<(), String> {
    validate_delete_path(&path)?;
    let sftp = open_sftp(&host, port, &username, &password)?;
    if kind == "directory" {
        sftp.rmdir(Path::new(&path))
            .map_err(|error| format!("只能删除空目录：{error}"))
    } else {
        sftp.unlink(Path::new(&path))
            .map_err(|error| format!("删除文件失败：{error}"))
    }
}

#[tauri::command(async)]
pub(crate) fn read_sftp_file(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let sftp = open_sftp(&host, port, &username, &password)?;
    let mut file = sftp
        .open(Path::new(&path))
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let stat = file.stat().map_err(|error| error.to_string())?;
    validate_download_size(stat.size.unwrap_or(0))?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    Ok(data)
}

#[tauri::command(async)]
pub(crate) fn write_sftp_file(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    validate_upload_size(data.len())?;
    let sftp = open_sftp(&host, port, &username, &password)?;
    let mut file = sftp
        .create(Path::new(&path))
        .map_err(|error| format!("创建远程文件失败：{error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("上传写入失败：{error}"))?;
    file.flush()
        .map_err(|error| format!("上传刷新失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_directory_permissions_and_formats_file_sizes() {
        assert!(is_directory(0o040755));
        assert!(!is_directory(0o100644));
        assert_eq!(format_file_size(512), "512 B");
        assert_eq!(format_file_size(1536), "1.5 KB");
        assert_eq!(format_file_size(1_572_864), "1.5 MB");
    }

    #[test]
    fn maps_and_sorts_directory_entries_with_directories_first() {
        let mut entries = vec![
            map_directory_entry(PathBuf::from("/tmp/z.txt"), 0o100644, 5, Some(12)).unwrap(),
            map_directory_entry(PathBuf::from("/tmp/Alpha"), 0o040755, 0, None).unwrap(),
        ];
        sort_directory_entries(&mut entries);

        assert_eq!(entries[0].name, "Alpha");
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[0].size, "—");
        assert_eq!(entries[1].size, "5 B");
        assert_eq!(entries[1].modified, "12");
    }

    #[test]
    fn rejects_root_deletion_and_allows_regular_paths() {
        assert_eq!(
            validate_delete_path("/").unwrap_err(),
            "安全策略禁止删除根目录"
        );
        assert_eq!(
            validate_delete_path("  ").unwrap_err(),
            "安全策略禁止删除根目录"
        );
        assert!(validate_delete_path("/tmp/project").is_ok());
    }

    #[test]
    fn enforces_existing_transfer_size_limits() {
        assert!(validate_download_size(MAX_TRANSFER_SIZE as u64).is_ok());
        assert!(validate_upload_size(MAX_TRANSFER_SIZE).is_ok());
        assert!(validate_download_size(MAX_TRANSFER_SIZE as u64 + 1).is_err());
        assert!(validate_upload_size(MAX_TRANSFER_SIZE + 1).is_err());
    }
}
