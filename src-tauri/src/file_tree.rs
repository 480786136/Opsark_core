use serde::Serialize;
use ssh2::{FileStat, Sftp};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const DEFAULT_EXCLUDES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".nuxt",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
    "venv",
];

#[derive(Debug, Clone)]
pub struct FileStructureNode {
    name: String,
    kind: String,
    children: Option<Vec<FileStructureNode>>,
    depth_limited: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStructureResult {
    path_status: &'static str,
    tree: String,
    truncated: bool,
    warnings: Vec<String>,
}

// Only the protocol's ENOENT is an absence observation. Permission, transport
// and generic I/O errors remain failures; never infer absence from error prose.
fn root_metadata(
    result: Result<FileStat, ssh2::Error>,
    root_path: &str,
) -> Result<Option<FileStat>, String> {
    match result {
        Ok(stat) => Ok(Some(stat)),
        Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => Ok(None),
        Err(error) => Err(format!("无法访问远程根目录 {root_path}：{error}")),
    }
}

fn missing_root() -> FileStructureResult {
    FileStructureResult {
        path_status: "missing",
        tree: String::new(),
        truncated: false,
        warnings: Vec::new(),
    }
}

struct ScanOptions {
    root_path: String,
    excludes: Vec<String>,
    max_depth: usize,
    max_nodes: usize,
    include_hidden: bool,
}

struct ScanState {
    total_nodes: usize,
    truncated: bool,
    warnings: Vec<String>,
}

fn normalize_remote_root_path(raw_path: &str) -> Result<String, String> {
    let path = raw_path.trim();
    if !path.starts_with('/') || path.contains('\0') {
        return Err("根路径必须是远端 POSIX 绝对目录路径".into());
    }
    ensure_lossless_sftp_path(path)?;

    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" => {}
            "." | ".." => return Err("远端根路径不能包含 . 或 .. 路径段".into()),
            _ => segments.push(segment),
        }
    }

    Ok(if segments.is_empty() {
        "/".into()
    } else {
        format!("/{}", segments.join("/"))
    })
}

fn normalize_remote_exclude(raw_exclude: &str, root_path: &str) -> Result<Option<String>, String> {
    // A backslash is a literal POSIX filename character, not a separator.
    let normalized = raw_exclude.trim();
    if normalized.contains('\0') {
        return Err(format!("排除目录不能包含 NUL 字符：{raw_exclude}"));
    }

    let absolute = normalized.starts_with('/');
    let mut segments = Vec::new();
    for segment in normalized.split('/') {
        match segment {
            "" => {}
            "." | ".." => return Err(format!("排除目录不能包含 . 或 .. 路径段：{raw_exclude}")),
            _ => segments.push(segment),
        }
    }

    if segments.is_empty() {
        return if absolute {
            Err(format!("排除目录不能与根路径相同：{raw_exclude}"))
        } else {
            Ok(None)
        };
    }

    let value = segments.join("/");
    if !absolute {
        return Ok(Some(value));
    }

    let absolute_path = format!("/{value}");
    if absolute_path == root_path {
        return Err(format!("排除目录不能与根路径相同：{raw_exclude}"));
    }
    if root_path != "/" && !absolute_path.starts_with(&format!("{root_path}/")) {
        return Err(format!(
            "绝对排除路径必须位于根路径 {root_path} 下：{raw_exclude}"
        ));
    }
    Ok(Some(absolute_path))
}

fn direct_remote_name(path: &Path) -> Result<Option<String>, String> {
    // File::readdir returns the direct child name. Never apply host-native
    // Path::file_name/join or strip a prefix from Sftp::readdir's joined path.
    let name = path
        .as_os_str()
        .to_str()
        .ok_or_else(|| "目录项名称不是 UTF-8，无法无损表示，已跳过该项".to_string())?;
    if matches!(name, "." | "..") {
        return Ok(None);
    }
    if name.is_empty() || name.contains('/') || name.contains('\0') {
        return Err(format!(
            "SFTP 返回了非法的直接子项名称：{name:?}，已跳过该项"
        ));
    }
    Ok(Some(name.to_string()))
}

fn ensure_lossless_sftp_path(path: &str) -> Result<(), String> {
    // ssh2 0.9.6 util::path2bytes on Windows rewrites every '\\' to '/'.
    // Refuse that lookup rather than accidentally visiting a different object.
    if cfg!(windows) && path.contains('\\') {
        return Err(format!(
            "Windows SFTP 依赖无法无损访问包含反斜杠的 POSIX 路径 {path:?}；已保留原名称并停止访问该路径"
        ));
    }
    Ok(())
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn validate_options(
    root_path: String,
    exclude_directories: Vec<String>,
    max_depth: usize,
    max_nodes: usize,
    include_hidden: bool,
) -> Result<ScanOptions, String> {
    let root_path = normalize_remote_root_path(&root_path)?;
    if !(1..=20).contains(&max_depth) {
        return Err("遍历深度必须在 1 到 20 之间".into());
    }
    if !(1..=10_000).contains(&max_nodes) {
        return Err("节点数量必须在 1 到 10000 之间".into());
    }

    let mut excludes: Vec<String> = DEFAULT_EXCLUDES
        .iter()
        .map(|item| item.to_string())
        .collect();
    for raw_exclude in exclude_directories {
        if let Some(exclude) = normalize_remote_exclude(&raw_exclude, &root_path)? {
            excludes.push(exclude);
        }
    }
    let mut seen = HashSet::new();
    excludes.retain(|item| seen.insert(item.clone()));

    Ok(ScanOptions {
        root_path,
        excludes,
        max_depth,
        max_nodes,
        include_hidden,
    })
}

fn kind_from_stat(stat: &FileStat) -> &'static str {
    match stat.perm.unwrap_or(0) & 0o170000 {
        0o040000 => "directory",
        0o100000 => "file",
        0o120000 => "symlink",
        _ => "other",
    }
}

fn is_excluded(root_path: &str, relative_path: &str, name: &str, excludes: &[String]) -> bool {
    let absolute_path = join_remote_path(root_path, relative_path);
    excludes.iter().any(|exclude| {
        if exclude.starts_with('/') {
            absolute_path == *exclude || absolute_path.starts_with(&format!("{exclude}/"))
        } else if exclude.contains('/') {
            relative_path == exclude || relative_path.starts_with(&format!("{exclude}/"))
        } else {
            name == exclude
        }
    })
}

struct DirectoryEntries {
    entries: Vec<(String, FileStat)>,
    warnings: Vec<String>,
}

fn collect_directory_entries<F>(absolute_path: &str, mut read_next: F) -> DirectoryEntries
where
    F: FnMut() -> Result<(PathBuf, FileStat), ssh2::Error>,
{
    let mut result = DirectoryEntries {
        entries: Vec::new(),
        warnings: Vec::new(),
    };
    loop {
        // Only the dependency read is guarded: ssh2's Windows mkpath unwraps
        // UTF-8 decoding. Stop this directory on a decode panic; do not resume
        // reading or hide failures in the traversal/filtering code below.
        let next = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&mut read_next));
        match next {
            Ok(Ok((path, stat))) => match direct_remote_name(&path) {
                Ok(Some(name)) => result.entries.push((name, stat)),
                Ok(None) => {}
                Err(error) => result.warnings.push(format!("{absolute_path}：{error}")),
            },
            // ssh2::File::readdir uses LIBSSH2_ERROR_FILE (-16) for EOF.
            Ok(Err(error)) if error.code() == ssh2::ErrorCode::Session(-16) => break,
            Ok(Err(error)) => {
                result.warnings.push(format!(
                    "远程目录 {absolute_path} 未读取完整：{error}；已保留此前返回的目录项"
                ));
                break;
            }
            Err(_) => {
                result.warnings.push(format!(
                    "远程目录 {absolute_path} 的 SFTP 目录项读取/解码异常，已停止读取并保留此前目录项；Windows 端 ssh2 不支持非 UTF-8 名称"
                ));
                break;
            }
        }
    }
    result
}

fn read_sftp_entries(sftp: &Sftp, absolute_path: &str) -> Result<DirectoryEntries, String> {
    ensure_lossless_sftp_path(absolute_path)?;
    let mut directory = sftp
        .opendir(Path::new(absolute_path))
        .map_err(|error| format!("无法读取远程目录 {absolute_path}：{error}"))?;
    Ok(collect_directory_entries(absolute_path, || {
        directory.readdir()
    }))
}

fn read_directory<F>(
    read_entries: &mut F,
    absolute_path: &str,
    relative_parent: &str,
    depth: usize,
    options: &ScanOptions,
    state: &mut ScanState,
) -> Result<Vec<FileStructureNode>, String>
where
    F: FnMut(&str) -> Result<DirectoryEntries, String>,
{
    ensure_lossless_sftp_path(absolute_path)?;
    let DirectoryEntries {
        mut entries,
        warnings,
    } = read_entries(absolute_path)?;
    state.warnings.extend(warnings);
    entries.sort_by(|(left_name, left_stat), (right_name, right_stat)| {
        let left_kind = kind_from_stat(left_stat);
        let right_kind = kind_from_stat(right_stat);
        let left_directory = left_kind == "directory";
        let right_directory = right_kind == "directory";
        right_directory
            .cmp(&left_directory)
            .then_with(|| left_name.to_lowercase().cmp(&right_name.to_lowercase()))
            .then_with(|| left_name.cmp(right_name))
    });

    let mut nodes = Vec::new();
    for (name, stat) in entries {
        if !options.include_hidden && name.starts_with('.') {
            continue;
        }
        let relative_path = if relative_parent.is_empty() {
            name.clone()
        } else {
            format!("{relative_parent}/{name}")
        };
        let kind = kind_from_stat(&stat);
        if kind == "directory"
            && is_excluded(&options.root_path, &relative_path, &name, &options.excludes)
        {
            continue;
        }
        if state.total_nodes >= options.max_nodes {
            state.truncated = true;
            break;
        }

        state.total_nodes += 1;
        let mut node = FileStructureNode {
            name: name.clone(),
            kind: kind.to_string(),
            children: (kind == "directory").then(Vec::new),
            depth_limited: false,
        };

        if kind == "directory" {
            if depth < options.max_depth {
                let child_path = join_remote_path(absolute_path, &name);
                match read_directory(
                    read_entries,
                    &child_path,
                    &relative_path,
                    depth + 1,
                    options,
                    state,
                ) {
                    Ok(children) => node.children = Some(children),
                    Err(error) => state.warnings.push(error),
                }
            } else {
                node.depth_limited = true;
                state.truncated = true;
            }
        }
        nodes.push(node);
    }
    Ok(nodes)
}

fn printable_name(name: &str) -> String {
    name.replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn render_tree_nodes(nodes: &[FileStructureNode], prefix: &str, output: &mut String) {
    for (index, node) in nodes.iter().enumerate() {
        let last = index + 1 == nodes.len();
        output.push_str(prefix);
        output.push_str(if last { "└── " } else { "├── " });
        output.push_str(&printable_name(&node.name));
        match node.kind.as_str() {
            "directory" => output.push('/'),
            "symlink" => output.push('@'),
            "other" => output.push('?'),
            _ => {}
        }
        output.push('\n');
        if let Some(children) = &node.children {
            let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
            render_tree_nodes(children, &child_prefix, output);
            if node.depth_limited {
                output.push_str(&child_prefix);
                output.push_str("└── …\n");
            }
        }
    }
}

fn render_tree(root_path: &str, nodes: &[FileStructureNode]) -> String {
    let mut output = if root_path == "/" {
        "/\n".to_string()
    } else {
        format!("{}/\n", root_path.trim_end_matches('/'))
    };
    render_tree_nodes(nodes, "", &mut output);
    output.trim_end().to_string()
}

pub fn scan_sftp(
    sftp: &Sftp,
    root_path: String,
    exclude_directories: Vec<String>,
    max_depth: usize,
    max_nodes: usize,
    include_hidden: bool,
) -> Result<FileStructureResult, String> {
    let options = validate_options(
        root_path,
        exclude_directories,
        max_depth,
        max_nodes,
        include_hidden,
    )?;
    // lstat distinguishes a missing entry from an occupied dangling symlink.
    let Some(entry_stat) = root_metadata(
        sftp.lstat(Path::new(&options.root_path)),
        &options.root_path,
    )?
    else {
        return Ok(missing_root());
    };
    let root_stat = if kind_from_stat(&entry_stat) == "symlink" {
        sftp.stat(Path::new(&options.root_path)).map_err(|error| {
            format!(
                "根路径符号链接存在但无法读取其目标 {}：{error}",
                options.root_path
            )
        })?
    } else {
        entry_stat
    };
    if kind_from_stat(&root_stat) != "directory" {
        return Err(format!("远程路径不是目录：{}", options.root_path));
    }

    let mut state = ScanState {
        total_nodes: 0,
        truncated: false,
        warnings: Vec::new(),
    };
    let nodes = read_directory(
        &mut |path| read_sftp_entries(sftp, path),
        &options.root_path,
        "",
        1,
        &options,
        &mut state,
    )?;
    Ok(FileStructureResult {
        path_status: "directory",
        tree: render_tree(&options.root_path, &nodes),
        truncated: state.truncated || !state.warnings.is_empty(),
        warnings: state.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_missing_entry_is_a_successful_absence_observation() {
        let missing = ssh2::Error::new(ssh2::ErrorCode::SFTP(2), "no such file");
        assert!(root_metadata(Err(missing), "/opt/report")
            .unwrap()
            .is_none());
        let data = serde_json::to_value(missing_root()).unwrap();
        assert_eq!(data["pathStatus"], "missing");
        assert_eq!(data["tree"], "");
        assert_eq!(data["truncated"], false);
        for code in [
            ssh2::ErrorCode::SFTP(3),
            ssh2::ErrorCode::SFTP(4),
            ssh2::ErrorCode::Session(-43),
        ] {
            // Even misleading error text cannot turn a different status into ENOENT.
            assert!(
                root_metadata(Err(ssh2::Error::new(code, "no such file")), "/opt/report").is_err()
            );
        }
    }

    #[test]
    fn validates_and_deduplicates_caller_excludes() {
        let options = validate_options(
            "/opt/app/".into(),
            vec!["uploads".into(), "storage/cache".into(), "uploads".into()],
            6,
            2000,
            false,
        )
        .unwrap();

        assert_eq!(options.root_path, "/opt/app");
        assert!(options.excludes.contains(&".git".to_string()));
        assert!(options.excludes.contains(&"node_modules".to_string()));
        assert_eq!(
            options
                .excludes
                .iter()
                .filter(|item| *item == "uploads")
                .count(),
            1
        );
        assert!(is_excluded(
            &options.root_path,
            "storage/cache/items",
            "items",
            &options.excludes
        ));
    }

    #[test]
    fn accepts_absolute_excludes_below_the_remote_root() {
        let options = validate_options(
            "/".into(),
            vec![
                "/proc".into(),
                " //proc/ ".into(),
                "//sys/".into(),
                "/dev".into(),
                " /run// ".into(),
                "/var/lib/docker/overlay2".into(),
            ],
            3,
            600,
            false,
        )
        .unwrap();

        assert!(options.excludes.contains(&"/proc".to_string()));
        assert_eq!(
            options
                .excludes
                .iter()
                .filter(|item| *item == "/proc")
                .count(),
            1
        );
        assert!(options.excludes.contains(&"/sys".to_string()));
        assert!(is_excluded("/", "proc", "proc", &options.excludes));
        assert!(is_excluded(
            "/",
            "var/lib/docker/overlay2/abc",
            "abc",
            &options.excludes
        ));
        assert!(!is_excluded("/", "opt/proc", "proc", &options.excludes));
        assert!(!is_excluded("/", "proc2", "proc2", &options.excludes));

        let nested = validate_options(
            "/opt/app".into(),
            vec!["/opt/app/storage/cache/".into()],
            3,
            600,
            false,
        )
        .unwrap();
        assert!(is_excluded(
            "/opt/app",
            "storage/cache/items",
            "items",
            &nested.excludes
        ));
    }

    #[test]
    fn rejects_unsafe_excludes_and_invalid_limits() {
        assert!(validate_options("relative".into(), vec![], 6, 2000, false).is_err());
        assert!(validate_options("C:\\opt\\app".into(), vec![], 6, 2000, false).is_err());
        assert!(validate_options("/opt/../app".into(), vec![], 6, 2000, false).is_err());
        assert!(validate_options("/opt/./app".into(), vec![], 6, 2000, false).is_err());
        assert!(
            validate_options("/opt/app".into(), vec!["../etc".into()], 6, 2000, false).is_err()
        );
        // POSIX '..\\etc' is one literal filename, not a parent traversal.
        assert!(
            validate_options("/opt/app".into(), vec!["..\\etc".into()], 6, 2000, false).is_ok()
        );
        assert!(validate_options(
            "/opt/app".into(),
            vec!["/opt/app/../etc".into()],
            6,
            2000,
            false
        )
        .is_err());
        assert!(validate_options("/opt/app".into(), vec!["/etc".into()], 6, 2000, false).is_err());
        assert!(validate_options(
            "/opt/app".into(),
            vec!["/opt/application/cache".into()],
            6,
            2000,
            false
        )
        .is_err());
        assert!(validate_options("/".into(), vec!["/".into()], 6, 2000, false).is_err());
        assert!(
            validate_options("/opt/app".into(), vec!["/opt/app".into()], 6, 2000, false).is_err()
        );
        assert!(validate_options("/opt/app".into(), vec![], 0, 2000, false).is_err());
        assert!(validate_options("/opt/app".into(), vec![], 6, 10_001, false).is_err());
    }

    #[test]
    fn normalizes_and_joins_remote_paths_with_posix_semantics() {
        let options = validate_options("//opt///app//".into(), vec![], 6, 2000, false).unwrap();

        assert_eq!(options.root_path, "/opt/app");
        assert_eq!(join_remote_path("/opt/app", "src"), "/opt/app/src");
        assert_eq!(join_remote_path("/", "src"), "/src");
        assert_eq!(
            direct_remote_name(Path::new("src")).unwrap(),
            Some("src".into())
        );
        assert!(direct_remote_name(Path::new("/opt/app/src")).is_err());
    }

    fn stat_for_mode(perm: u32) -> FileStat {
        FileStat {
            size: Some(10),
            uid: None,
            gid: None,
            perm: Some(perm),
            atime: None,
            mtime: None,
        }
    }

    fn new_state() -> ScanState {
        ScanState {
            total_nodes: 0,
            truncated: false,
            warnings: Vec::new(),
        }
    }

    fn directory_entries(items: &[(&str, u32)]) -> DirectoryEntries {
        DirectoryEntries {
            entries: items
                .iter()
                .map(|(name, mode)| (name.to_string(), stat_for_mode(*mode)))
                .collect(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn walks_unicode_children_with_posix_paths_and_does_not_follow_links() {
        let options = validate_options("/opt/订单应用".into(), vec![], 6, 2000, false).unwrap();
        let mut calls = Vec::new();
        let mut reader = |path: &str| {
            calls.push(path.to_string());
            Ok(match path {
                "/opt/订单应用" => directory_entries(&[
                    ("配置链接", 0o120777),
                    ("层一", 0o040755),
                    ("README.md", 0o100644),
                    ("node_modules", 0o040755),
                ]),
                "/opt/订单应用/层一" => directory_entries(&[("层二", 0o040755)]),
                "/opt/订单应用/层一/层二" => directory_entries(&[("配置.json", 0o100644)]),
                _ => panic!("unexpected remote path {path}"),
            })
        };
        let mut state = new_state();
        let nodes =
            read_directory(&mut reader, &options.root_path, "", 1, &options, &mut state).unwrap();
        assert_eq!(
            calls,
            [
                "/opt/订单应用",
                "/opt/订单应用/层一",
                "/opt/订单应用/层一/层二"
            ]
        );
        assert_eq!(render_tree(&options.root_path, &nodes), "/opt/订单应用/\n├── 层一/\n│   └── 层二/\n│       └── 配置.json\n├── README.md\n└── 配置链接@");
        assert!(state.warnings.is_empty());
        assert!(!state.truncated);
    }

    #[test]
    fn preserves_literal_backslashes_and_never_redirects_a_remote_lookup() {
        assert_eq!(
            direct_remote_name(Path::new("配置\\备份")).unwrap(),
            Some("配置\\备份".into())
        );
        assert_eq!(
            join_remote_path("/opt/app", "配置\\备份"),
            "/opt/app/配置\\备份"
        );
        let options =
            validate_options("/opt/app".into(), vec!["缓存\\旧".into()], 6, 2000, false).unwrap();
        assert!(is_excluded(
            "/opt/app",
            "缓存\\旧",
            "缓存\\旧",
            &options.excludes
        ));
        assert!(!is_excluded("/opt/app", "缓存/旧", "旧", &options.excludes));
        let mut calls = Vec::new();
        let mut reader = |path: &str| {
            calls.push(path.to_string());
            Ok(match path {
                "/opt/app" => directory_entries(&[("配置\\备份", 0o040755), ("配置", 0o040755)]),
                "/opt/app/配置" => directory_entries(&[("备份", 0o040755)]),
                "/opt/app/配置/备份" => directory_entries(&[("不同对象.txt", 0o100644)]),
                "/opt/app/配置\\备份" => directory_entries(&[("原始对象.txt", 0o100644)]),
                _ => panic!("unexpected remote path {path}"),
            })
        };
        let mut state = new_state();
        let nodes =
            read_directory(&mut reader, &options.root_path, "", 1, &options, &mut state).unwrap();
        let tree = render_tree(&options.root_path, &nodes);
        assert!(tree.contains("配置\\备份/"));
        assert!(tree.contains("不同对象.txt"));
        assert_eq!(
            calls
                .iter()
                .filter(|path| path.as_str() == "/opt/app/配置/备份")
                .count(),
            1
        );
        if cfg!(windows) {
            assert!(!calls.contains(&"/opt/app/配置\\备份".into()));
            assert!(!tree.contains("原始对象.txt"));
            assert!(state
                .warnings
                .iter()
                .any(|warning| warning.contains("无法无损访问")));
            assert!(normalize_remote_root_path("/opt/app/配置\\备份").is_err());
        } else {
            assert!(calls.contains(&"/opt/app/配置\\备份".into()));
            assert!(tree.contains("原始对象.txt"));
            assert!(state.warnings.is_empty());
            assert!(normalize_remote_root_path("/opt/app/配置\\备份").is_ok());
        }
    }

    #[test]
    fn retains_partial_entries_and_warnings_on_read_failure_or_decode_panic() {
        let mut items = vec![
            Ok((PathBuf::from("."), stat_for_mode(0o040755))),
            Ok((PathBuf::from(".."), stat_for_mode(0o040755))),
            Ok((PathBuf::from("正常.txt"), stat_for_mode(0o100644))),
            Ok((PathBuf::from("parent/child"), stat_for_mode(0o040755))),
            Err(ssh2::Error::new(
                ssh2::ErrorCode::SFTP(3),
                "permission denied",
            )),
        ]
        .into_iter();
        let collected = collect_directory_entries("/opt/app", || items.next().unwrap());
        assert_eq!(collected.entries.len(), 1);
        assert_eq!(collected.entries[0].0, "正常.txt");
        assert_eq!(collected.warnings.len(), 2);
        assert!(collected.warnings[0].contains("非法的直接子项"));
        assert!(collected.warnings[1].contains("未读取完整"));
        let mut calls = 0;
        let decoded = collect_directory_entries("/opt/app", || {
            calls += 1;
            if calls == 1 {
                Ok((PathBuf::from("已读取.txt"), stat_for_mode(0o100644)))
            } else {
                panic!("simulated dependency filename decoder panic");
            }
        });
        assert_eq!(calls, 2);
        assert_eq!(decoded.entries.len(), 1);
        assert!(decoded.warnings[0].contains("读取/解码异常"));
    }

    #[test]
    fn recognizes_only_readdir_eof_as_complete_and_does_not_spin_on_eagain() {
        let done = collect_directory_entries("/opt/app", || {
            Err(ssh2::Error::new(
                ssh2::ErrorCode::Session(-16),
                "no more files",
            ))
        });
        assert!(done.warnings.is_empty());
        let mut calls = 0;
        let waiting = collect_directory_entries("/opt/app", || {
            calls += 1;
            Err(ssh2::Error::new(
                ssh2::ErrorCode::Session(-37),
                "would block",
            ))
        });
        assert_eq!(calls, 1);
        assert_eq!(waiting.warnings.len(), 1);
    }

    #[test]
    fn reports_depth_node_and_child_read_limits_without_claiming_complete_coverage() {
        for (max_depth, max_nodes) in [(1, 2000), (6, 1)] {
            let options =
                validate_options("/opt/app".into(), vec![], max_depth, max_nodes, false).unwrap();
            let mut state = new_state();
            let mut reader = |_: &str| {
                Ok(directory_entries(&[
                    ("目录", 0o040755),
                    ("文件.txt", 0o100644),
                ]))
            };
            let _ = read_directory(&mut reader, &options.root_path, "", 1, &options, &mut state)
                .unwrap();
            assert!(state.truncated);
        }
        let options = validate_options("/opt/app".into(), vec![], 6, 2000, false).unwrap();
        let mut state = new_state();
        let mut reader = |path: &str| {
            if path == "/opt/app" {
                Ok(directory_entries(&[
                    ("保留目录", 0o040755),
                    ("可读文件.txt", 0o100644),
                ]))
            } else {
                Err("permission denied".to_string())
            }
        };
        let nodes =
            read_directory(&mut reader, &options.root_path, "", 1, &options, &mut state).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(state.warnings, ["permission denied"]);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_utf8_names_without_lossy_substitution() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let name = PathBuf::from(OsString::from_vec(vec![b'a', 0xff]));
        assert!(direct_remote_name(&name)
            .unwrap_err()
            .contains("无法无损表示"));
    }

    #[test]
    fn classifies_file_modes_without_following_links() {
        let stat = |perm| FileStat {
            size: Some(10),
            uid: None,
            gid: None,
            perm: Some(perm),
            atime: None,
            mtime: None,
        };

        assert_eq!(kind_from_stat(&stat(0o040755)), "directory");
        assert_eq!(kind_from_stat(&stat(0o100644)), "file");
        assert_eq!(kind_from_stat(&stat(0o120777)), "symlink");
    }

    #[test]
    fn renders_a_compact_stable_tree() {
        let nodes = vec![
            FileStructureNode {
                name: "src".into(),
                kind: "directory".into(),
                children: Some(vec![FileStructureNode {
                    name: "main.rs".into(),
                    kind: "file".into(),
                    children: None,
                    depth_limited: false,
                }]),
                depth_limited: false,
            },
            FileStructureNode {
                name: "README.md".into(),
                kind: "file".into(),
                children: None,
                depth_limited: false,
            },
        ];

        assert_eq!(
            render_tree("/opt/app", &nodes),
            "/opt/app/\n├── src/\n│   └── main.rs\n└── README.md"
        );
    }
}
