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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFilePrefix {
    data: Vec<u8>,
    total_bytes: u64,
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
    // SFTP paths are always POSIX paths. `PathBuf` renders separators using the
    // host OS, which previously leaked `\\` into remote paths on Windows.
    let path = entry_path.to_string_lossy().replace('\\', "/");
    let name = path.rsplit('/').find(|part| !part.is_empty())?.to_string();
    if matches!(name.as_str(), "." | "..") {
        return None;
    }
    let directory = is_directory(permission);
    Some(RemoteFileEntry {
        name,
        path,
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

fn normalize_delete_path(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("安全策略禁止删除根目录".into());
    }
    if !path.starts_with('/') {
        return Err("安全策略只允许删除绝对远程路径".into());
    }

    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            value => components.push(value),
        }
    }
    if components.is_empty() {
        return Err("安全策略禁止删除根目录".into());
    }
    Ok(format!("/{}", components.join("/")))
}

fn delete_sftp_directory_recursively(sftp: &Sftp, root: &Path) -> Result<(), String> {
    // Use an explicit post-order stack so deeply nested remote trees cannot
    // overflow the application stack. lstat prevents following directory
    // symlinks outside the selected tree.
    let mut pending = vec![(root.to_path_buf(), false)];
    while let Some((path, children_visited)) = pending.pop() {
        if children_visited {
            sftp.rmdir(&path)
                .map_err(|error| format!("删除远程目录 {} 失败：{error}", path.display()))?;
            continue;
        }

        let entries = sftp
            .readdir(&path)
            .map_err(|error| format!("读取待删除目录 {} 失败：{error}", path.display()))?;
        pending.push((path, true));
        for (entry_path, _) in entries {
            let stat = sftp
                .lstat(&entry_path)
                .map_err(|error| format!("读取待删除项 {} 失败：{error}", entry_path.display()))?;
            if is_directory(stat.perm.unwrap_or(0)) {
                pending.push((entry_path, false));
            } else {
                sftp.unlink(&entry_path).map_err(|error| {
                    format!("删除远程项 {} 失败：{error}", entry_path.display())
                })?;
            }
        }
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

fn validate_content_read_size(size: usize) -> Result<(), String> {
    if !(1..=262_144).contains(&size) {
        return Err("文件内容读取上限必须介于 1 到 262144 字节".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn read_local_file_for_upload(path: String) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("无法读取本地文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("只能拖放普通文件，暂不支持文件夹".into());
    }
    validate_upload_size(metadata.len() as usize)?;
    std::fs::read(&path).map_err(|error| format!("无法读取本地文件：{error}"))
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
    let path = normalize_delete_path(&path)?;
    let sftp = open_sftp(&host, port, &username, &password)?;
    match kind.as_str() {
        "directory" => {
            let stat = sftp
                .lstat(Path::new(&path))
                .map_err(|error| format!("读取待删除目录 {path} 失败：{error}"))?;
            if is_directory(stat.perm.unwrap_or(0)) {
                delete_sftp_directory_recursively(&sftp, Path::new(&path))
            } else {
                // The entry may have changed since it was listed. Never follow
                // a replacement symlink merely because the UI reported a directory.
                sftp.unlink(Path::new(&path))
                    .map_err(|error| format!("删除远程项 {path} 失败：{error}"))
            }
        }
        "file" => sftp
            .unlink(Path::new(&path))
            .map_err(|error| format!("删除文件失败：{error}")),
        _ => Err("不支持的远程项类型".into()),
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
pub(crate) fn read_sftp_file_prefix(
    host: String,
    port: u16,
    username: String,
    password: String,
    path: String,
    max_bytes: usize,
) -> Result<RemoteFilePrefix, String> {
    validate_content_read_size(max_bytes)?;
    let sftp = open_sftp(&host, port, &username, &password)?;
    let mut file = sftp
        .open(Path::new(&path))
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let total_bytes = file
        .stat()
        .map_err(|error| error.to_string())?
        .size
        .unwrap_or(0);
    let mut data = Vec::with_capacity(max_bytes.min(total_bytes as usize));
    file.take(max_bytes as u64)
        .read_to_end(&mut data)
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    Ok(RemoteFilePrefix { data, total_bytes })
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
    fn serializes_remote_paths_with_posix_separators() {
        let entry =
            map_directory_entry(PathBuf::from(r"/boot/loader\entries"), 0o040755, 0, None).unwrap();

        assert_eq!(entry.name, "entries");
        assert_eq!(entry.path, "/boot/loader/entries");
    }

    #[test]
    fn normalizes_delete_paths_and_rejects_root_equivalents() {
        assert_eq!(
            normalize_delete_path("/").unwrap_err(),
            "安全策略禁止删除根目录"
        );
        assert_eq!(
            normalize_delete_path("  ").unwrap_err(),
            "安全策略禁止删除根目录"
        );
        assert_eq!(
            normalize_delete_path("/tmp/../.").unwrap_err(),
            "安全策略禁止删除根目录"
        );
        assert_eq!(
            normalize_delete_path("tmp/project").unwrap_err(),
            "安全策略只允许删除绝对远程路径"
        );
        assert_eq!(
            normalize_delete_path("/tmp//project/./build/.."),
            Ok("/tmp/project".into())
        );
    }

    #[test]
    fn enforces_existing_transfer_size_limits() {
        assert!(validate_download_size(MAX_TRANSFER_SIZE as u64).is_ok());
        assert!(validate_upload_size(MAX_TRANSFER_SIZE).is_ok());
        assert!(validate_download_size(MAX_TRANSFER_SIZE as u64 + 1).is_err());
        assert!(validate_upload_size(MAX_TRANSFER_SIZE + 1).is_err());
        assert!(validate_content_read_size(1).is_ok());
        assert!(validate_content_read_size(262_144).is_ok());
        assert!(validate_content_read_size(0).is_err());
        assert!(validate_content_read_size(262_145).is_err());
    }
}
