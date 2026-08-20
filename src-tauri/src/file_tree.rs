use serde::Serialize;
use ssh2::{FileStat, Sftp};
use std::collections::HashSet;
use std::path::{Component, Path};

const DEFAULT_EXCLUDES: &[&str] = &[];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStructureNode {
    name: String,
    relative_path: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileStructureNode>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStructureResult {
    root_path: String,
    nodes: Vec<FileStructureNode>,
    excluded_directories: Vec<String>,
    total_nodes: usize,
    max_depth_reached: bool,
    truncated: bool,
    warnings: Vec<String>,
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
    max_depth_reached: bool,
    truncated: bool,
    warnings: Vec<String>,
}

fn validate_options(
    root_path: String,
    exclude_directories: Vec<String>,
    max_depth: usize,
    max_nodes: usize,
    include_hidden: bool,
) -> Result<ScanOptions, String> {
    let root_path = root_path.trim().trim_end_matches('/');
    let root_path = if root_path.is_empty() { "/" } else { root_path };
    if !Path::new(root_path).is_absolute() {
        return Err("根路径必须是远端绝对目录路径".into());
    }
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
        let normalized_exclude = raw_exclude.trim().replace('\\', "/");
        if normalized_exclude.starts_with('/') {
            return Err(format!(
                "排除目录必须是目录名或根目录下的相对路径：{raw_exclude}"
            ));
        }
        let exclude = normalized_exclude.trim_matches('/');
        if exclude.is_empty() {
            continue;
        }
        let path = Path::new(exclude);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!(
                "排除目录必须是目录名或根目录下的相对路径：{raw_exclude}"
            ));
        }
        excludes.push(exclude.to_string());
    }
    let mut seen = HashSet::new();
    excludes.retain(|item| seen.insert(item.clone()));

    Ok(ScanOptions {
        root_path: root_path.to_string(),
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

fn is_excluded(relative_path: &str, name: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|exclude| {
        if exclude.contains('/') {
            relative_path == exclude || relative_path.starts_with(&format!("{exclude}/"))
        } else {
            name == exclude
        }
    })
}

fn read_directory(
    sftp: &Sftp,
    absolute_path: &Path,
    relative_parent: &str,
    depth: usize,
    options: &ScanOptions,
    state: &mut ScanState,
) -> Result<Vec<FileStructureNode>, String> {
    let mut entries = sftp
        .readdir(absolute_path)
        .map_err(|error| format!("无法读取远程目录 {}：{error}", absolute_path.display()))?;
    entries.retain(|(path, _)| {
        path.file_name()
            .and_then(|name| name.to_str())
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
                left_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .cmp(
                        &right_path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase(),
                    )
            })
            .then_with(|| {
                left_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .cmp(&right_path.file_name().unwrap_or_default().to_string_lossy())
            })
    });

    let mut nodes = Vec::new();
    for (entry_path, stat) in entries {
        if state.total_nodes >= options.max_nodes {
            state.truncated = true;
            break;
        }
        let Some(name) = entry_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
        else {
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
        if kind == "directory" && is_excluded(&relative_path, &name, &options.excludes) {
            continue;
        }

        state.total_nodes += 1;
        let mut node = FileStructureNode {
            name: name.clone(),
            relative_path: relative_path.clone(),
            kind: kind.to_string(),
            size: (kind != "directory").then_some(stat.size.unwrap_or(0)),
            children: (kind == "directory").then(Vec::new),
        };

        if kind == "directory" {
            if depth >= options.max_depth {
                state.max_depth_reached = true;
            } else {
                let child_path = absolute_path.join(&name);
                match read_directory(sftp, &child_path, &relative_path, depth + 1, options, state) {
                    Ok(children) => node.children = Some(children),
                    Err(error) => state.warnings.push(error),
                }
            }
        }
        nodes.push(node);
    }
    Ok(nodes)
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
    let root = Path::new(&options.root_path);
    let root_stat = sftp
        .stat(root)
        .map_err(|error| format!("无法访问远程根目录 {}：{error}", options.root_path))?;
    if kind_from_stat(&root_stat) != "directory" {
        return Err(format!("远程路径不是目录：{}", options.root_path));
    }

    let mut state = ScanState {
        total_nodes: 0,
        max_depth_reached: false,
        truncated: false,
        warnings: Vec::new(),
    };
    let nodes = read_directory(sftp, root, "", 1, &options, &mut state)?;
    Ok(FileStructureResult {
        root_path: options.root_path,
        nodes,
        excluded_directories: options.excludes,
        total_nodes: state.total_nodes,
        max_depth_reached: state.max_depth_reached,
        truncated: state.truncated,
        warnings: state.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!options.excludes.contains(&"node_modules".to_string()));
        assert_eq!(
            options
                .excludes
                .iter()
                .filter(|item| *item == "uploads")
                .count(),
            1
        );
        assert!(is_excluded(
            "storage/cache/items",
            "items",
            &options.excludes
        ));
    }

    #[test]
    fn rejects_unsafe_excludes_and_invalid_limits() {
        assert!(validate_options("relative".into(), vec![], 6, 2000, false).is_err());
        assert!(
            validate_options("/opt/app".into(), vec!["../etc".into()], 6, 2000, false).is_err()
        );
        assert!(
            validate_options("/opt/app".into(), vec!["..\\etc".into()], 6, 2000, false).is_err()
        );
        assert!(validate_options("/opt/app".into(), vec!["/etc".into()], 6, 2000, false).is_err());
        assert!(validate_options("/opt/app".into(), vec![], 0, 2000, false).is_err());
        assert!(validate_options("/opt/app".into(), vec![], 6, 10_001, false).is_err());
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
}
