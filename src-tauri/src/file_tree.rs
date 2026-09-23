use serde::Serialize;
use ssh2::{FileStat, Sftp};
use std::collections::HashSet;
use std::path::Path;

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
    if !path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err("根路径必须是远端 POSIX 绝对目录路径".into());
    }

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
    let normalized = raw_exclude.trim().replace('\\', "/");
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

fn remote_file_name(path: &Path) -> Option<String> {
    let path = path.to_string_lossy();
    let name = path.trim_end_matches('/').rsplit('/').next()?;
    (!name.is_empty()).then(|| name.to_string())
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

fn read_directory(
    sftp: &Sftp,
    absolute_path: &str,
    relative_parent: &str,
    depth: usize,
    options: &ScanOptions,
    state: &mut ScanState,
) -> Result<Vec<FileStructureNode>, String> {
    let mut entries = sftp
        .readdir(Path::new(absolute_path))
        .map_err(|error| format!("无法读取远程目录 {absolute_path}：{error}"))?;
    entries.retain(|(path, _)| {
        remote_file_name(path)
            .map(|name| name != "." && name != "..")
            .unwrap_or(false)
    });
    entries.sort_by(|(left_path, left_stat), (right_path, right_stat)| {
        let left_kind = kind_from_stat(left_stat);
        let right_kind = kind_from_stat(right_stat);
        let left_directory = left_kind == "directory";
        let right_directory = right_kind == "directory";
        right_directory
            .cmp(&left_directory)
            .then_with(|| {
                remote_file_name(left_path)
                    .unwrap_or_default()
                    .to_lowercase()
                    .cmp(
                        &remote_file_name(right_path)
                            .unwrap_or_default()
                            .to_lowercase(),
                    )
            })
            .then_with(|| {
                remote_file_name(left_path)
                    .unwrap_or_default()
                    .cmp(&remote_file_name(right_path).unwrap_or_default())
            })
    });

    let mut nodes = Vec::new();
    for (entry_path, stat) in entries {
        if state.total_nodes >= options.max_nodes {
            state.truncated = true;
            break;
        }
        let Some(name) = remote_file_name(&entry_path) else {
            continue;
        };
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
                match read_directory(sftp, &child_path, &relative_path, depth + 1, options, state) {
                    Ok(children) => node.children = Some(children),
                    Err(error) => state.warnings.push(error),
                }
            } else {
                node.depth_limited = true;
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
    let nodes = read_directory(sftp, &options.root_path, "", 1, &options, &mut state)?;
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
        assert!(
            validate_options("/opt/app".into(), vec!["..\\etc".into()], 6, 2000, false).is_err()
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
            remote_file_name(Path::new("/opt/app/src")),
            Some("src".into())
        );
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
