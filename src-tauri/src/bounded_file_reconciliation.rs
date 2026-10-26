//! Operation-specific proof for a bounded, literal backup-and-append Shell.
//! The approved command remains the source of the contract; prose is never proof.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Contract {
    pub file_path: String,
    pub backup_path: String,
    pub before_sha256: String,
    pub after_sha256: String,
    pub command_sha256: String,
}
fn hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
fn path_safe(value: &str) -> bool {
    value.starts_with('/') && !value.chars().any(|ch| matches!(ch, '\r' | '\n' | '\0' | '\\'))
        && !value.split('/').any(|part| matches!(part, "." | ".."))
}
fn name(value: &str) -> bool {
    !value.is_empty() && value.bytes().enumerate().all(|(index, byte)|
        byte.is_ascii_alphabetic() || byte == b'_' || index > 0 && byte.is_ascii_digit())
}
fn words(line: &str, variables: &HashMap<String, String>) -> Option<Vec<String>> {
    let chars: Vec<char> = line.chars().collect();
    let mut index = 0;
    let mut result = Vec::new();
    while index < chars.len() {
        if chars[index].is_whitespace() { index += 1; continue; }
        let mut word = String::new();
        while index < chars.len() && !chars[index].is_whitespace() {
            match chars[index] {
                '\'' => {
                    index += 1;
                    let start = index;
                    while index < chars.len() && chars[index] != '\'' { index += 1; }
                    if index == chars.len() { return None; }
                    let literal: String = chars[start..index].iter().collect();
                    if matches!(literal.as_str(), "|" | ">>" | "<<") { return None; }
                    word.push_str(&literal);
                    index += 1;
                }
                '"' => {
                    index += 1;
                    let start = index;
                    while index < chars.len() && chars[index] != '"' { index += 1; }
                    if index == chars.len() { return None; }
                    let value: String = chars[start..index].iter().collect();
                    if value == "'" { word.push('\''); }
                    else {
                        let variable = value.strip_prefix('$').filter(|value| name(value))?;
                        word.push_str(variables.get(variable)?);
                    }
                    index += 1;
                }
                ch @ ('|' | '<' | '>') => {
                    if !word.is_empty() { return None; }
                    word.push(ch); index += 1;
                    if ch != '|' {
                        if chars.get(index) != Some(&ch) { return None; }
                        word.push(ch); index += 1;
                    }
                    if index < chars.len() && !chars[index].is_whitespace() { return None; }
                    break;
                }
                ch if ch.is_ascii_alphanumeric() || "_./%+!=-".contains(ch) => { word.push(ch); index += 1; }
                _ => return None,
            }
        }
        result.push(word);
    }
    Some(result)
}
pub(crate) fn parse(command: &str) -> Option<Contract> {
    if command.chars().count() > 16_384 || command.contains(['\r', '\0']) { return None; }
    let lines: Vec<&str> = command.trim().split('\n').collect();
    if lines.first()?.trim() != "set -eu" { return None; }
    let mut cursor = 1;
    let mut variables = HashMap::new();
    while let Some(line) = lines.get(cursor) {
        let Some((key, value)) = line.trim().split_once('=') else { break; };
        if !name(key) { break; }
        let value = words(value, &variables)?;
        if value.len() != 1 || variables.contains_key(key) { return None; }
        variables.insert(key.into(), value[0].clone()); cursor += 1;
    }
    let first = lines.get(cursor)?.trim(); cursor += 1;
    let (before, file_path) = if let Some((cmp, marker)) = first.split_once(" <<'") {
        let marker = marker.strip_suffix('\'').filter(|marker| name(marker))?;
        let pre = words(cmp, &variables)?;
        if pre.len() != 5 || pre[..3] != ["cmp", "-s", "--"] || pre[4] != "-" { return None; }
        let end = (cursor..lines.len()).find(|index| lines[*index] == marker)?;
        let before = lines[cursor..end].join("\n") + if end > cursor { "\n" } else { "" };
        cursor = end + 1;
        (before, pre[3].clone())
    } else {
        let pre = words(first, &variables)?;
        if pre.len() < 7 || pre[0] != "printf" || pre[1] != "%s\\n" { return None; }
        let pipe = pre.iter().position(|word| word == "|")?;
        if pipe < 3 || pre.len() != pipe + 4 || pre[pipe + 1] != "cmp" || pre[pipe + 2] != "-" { return None; }
        (pre[2..pipe].iter().map(|line| format!("{line}\n")).collect::<String>(), pre[pipe + 3].clone())
    };
    let absence = words(lines.get(cursor)?.trim(), &variables)?; cursor += 1;
    if absence.len() != 4 || absence[..3] != ["test", "!", "-e"] { return None; }
    let backup_path = absence[3].clone();
    let copy = words(lines.get(cursor)?.trim(), &variables)?; cursor += 1;
    if copy != ["cp", "-p", "--", &file_path, &backup_path] { return None; }
    let append = words(lines.get(cursor)?.trim(), &variables)?; cursor += 1;
    if append.len() < 5 || append[..2] != ["printf", "%s\\n"] || append[append.len() - 2] != ">>"
        || append.last()? != &file_path || cursor != lines.len() || !path_safe(&file_path)
        || !path_safe(&backup_path) || file_path == backup_path { return None; }
    let after = before.clone() + &append[2..append.len()-2].iter().map(|line| format!("{line}\n")).collect::<String>();
    Some(Contract { file_path, backup_path, before_sha256: hash(&before), after_sha256: hash(&after), command_sha256: hash(command) })
}
pub(crate) fn from_semantic(semantic: &Value) -> Option<Contract> {
    if semantic["action"]["type"] != "shell" || semantic["runtimeClass"] != "bounded"
        || semantic["effect"] != "change" || semantic["executionScope"] != "isolated_exec"
        || semantic["targets"].as_array()?.iter().filter(|target| target["role"] == "execution").count() != 1 { return None; }
    parse(semantic["action"]["command"].as_str()?)
}
fn receipt_dir(execution_id: &str) -> Result<String, String> {
    crate::ssh::execution_pid_file(execution_id)?;
    Ok(format!("/tmp/opsark-receipt-{execution_id}"))
}

/// Executed inside the existing setsid process group. The result is written by
/// the child, so loss of the SSH parent/return channel cannot lose a completed
/// receipt. mkdir is one-shot; execution-id reuse never dispatches a second write.
pub(crate) fn tracked_payload(execution_id: &str, command: &str) -> Result<Option<String>, String> {
    let Some(contract) = parse(command) else { return Ok(None); };
    let quote = crate::ssh::shell_quote;
    let directory = quote(&receipt_dir(execution_id)?);
    let file = quote(&contract.file_path);
    Ok(Some(format!(r#"umask 077
mkdir -- {directory} || exit 125
receipt={directory}/done
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 125
start=$(awk '{{print $22}}' /proc/$$/stat) || exit 125
test -f {file} && test ! -L {file} || exit 125
sh -c {command}
code=$?
printf '%s\n' OPSARK_BOUNDED_FILE_V1 {execution_id} {digest} "$boot" "$$" "$start" "$code" > "$receipt.tmp" || exit 125
mv -- "$receipt.tmp" "$receipt" || exit 125
exit "$code""#,
        command = quote(command), execution_id = quote(execution_id), digest = quote(&contract.command_sha256))))
}

pub(crate) fn probe(contract: &Contract, execution_id: &str) -> Result<String, String> {
    let quote = crate::ssh::shell_quote;
    let receipt = quote(&format!("{}/done", receipt_dir(execution_id)?));
    let file = quote(&contract.file_path);
    let backup = quote(&contract.backup_path);
    Ok(format!("set -eu\ntest -f {receipt} && test ! -L {receipt}\ncat -- {receipt}\nprintf '%s\\n' CURRENT_BOOT\ncat /proc/sys/kernel/random/boot_id\nprintf '%s\\n' PROCESS_GROUPS\ngroups=$(ps -eo pgid=) || exit 125\ngroup=$(awk 'NR==5 {{print}}' {receipt}) || exit 125\ncase \"$group\" in ''|*[!0-9]*) exit 125;; esac\nprintf '%s\\n' \"$groups\" | awk -v p=\"$group\" '$1 == p {{found=1}} END {{print found ? p : 0}}'\nprintf '%s\\n' FILE_DIGESTS\ntest -f {file} && test ! -L {file}\ntest -f {backup} && test ! -L {backup}\nsha256sum -- {file} {backup}\nsha256sum -- {file} {backup}\nprintf '%s\\n' END"))
}
pub(crate) fn validate(contract: &Contract, execution_id: &str, output: &str) -> bool {
    let lines: Vec<&str> = output.trim().lines().map(|line| line.trim_end_matches('\r')).collect();
    if lines.len() < 17 || lines[0] != "OPSARK_BOUNDED_FILE_V1" || lines[1] != execution_id
        || lines[2] != contract.command_sha256 || lines[3].len() != 36
        || !lines[3].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
        || lines[4].parse::<u64>().is_err() || lines[4].parse::<u64>().unwrap() < 2
        || lines[5].is_empty() || !lines[5].bytes().all(|byte| byte.is_ascii_digit())
        || lines[6] != "0" || lines[7] != "CURRENT_BOOT" || lines[8] != lines[3] || lines[9] != "PROCESS_GROUPS" { return false; }
    let Some(boundary) = (10..lines.len()).find(|index| lines[*index] == "FILE_DIGESTS") else { return false; };
    if boundary < 11 || lines.len() != boundary + 6 || lines.last() != Some(&"END") { return false; }
    if lines[10..boundary].iter().any(|line| line.trim().is_empty()
        || !line.trim().bytes().all(|byte| byte.is_ascii_digit()) || line.trim() == lines[4]) { return false; }
    lines[boundary + 1] == format!("{}  {}", contract.after_sha256, contract.file_path)
        && lines[boundary + 2] == format!("{}  {}", contract.before_sha256, contract.backup_path)
        && lines[boundary + 3] == lines[boundary + 1] && lines[boundary + 4] == lines[boundary + 2]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_contract_and_probe_match_shared_typescript_protocol_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!("../../shared/bounded-file-reconciliation-fixtures.json")).unwrap();
        for example in fixtures["accepted"].as_array().unwrap() {
            let c = parse(example["command"].as_str().unwrap()).unwrap();
            assert_eq!(c.file_path, example["filePath"]);
            assert_eq!(c.backup_path, example["backupPath"]);
            assert_eq!(c.before_sha256, hash(example["before"].as_str().unwrap()));
            assert_eq!(c.after_sha256, hash(example["after"].as_str().unwrap()));
            assert_eq!(probe(&c, example["executionId"].as_str().unwrap()).unwrap(), example["probe"]);
        }
        for command in fixtures["rejected"].as_array().unwrap() { assert!(parse(command.as_str().unwrap()).is_none()); }
    }
    pub(super) fn command() -> String {
        "set -eu\nf='/tmp/发布记录.txt'\nb='/tmp/发布记录.txt.bak'\nprintf '%s\\n' 'old' | cmp - \"$f\"\ntest ! -e \"$b\"\ncp -p -- \"$f\" \"$b\"\nprintf '%s\\n' 'new' >> \"$f\"".into()
    }
    #[test]
    fn supports_literal_append_with_exact_before_and_backup_without_model_prose() {
        let contract = parse(&command()).unwrap();
        assert_eq!(contract.before_sha256, hash("old\n"));
        assert_eq!(contract.after_sha256, hash("old\nnew\n"));
        let heredoc = command().replace("printf '%s\\n' 'old' | cmp - \"$f\"", "cmp -s -- \"$f\" - <<'EOF'\nold\nEOF");
        assert_eq!(parse(&heredoc).unwrap().after_sha256, contract.after_sha256);
        for bad in [format!("{}\nrm /tmp/other", command()), command().replace("cp -p --", "cp -rf --"),
            command().replace("'new'", "\"$(touch /tmp/other)\""), command().replace("set -eu", "set -e"),
            command().replace("'/tmp/发布记录.txt.bak'", "'/tmp/发布记录.txt'")] {
            assert!(parse(&bad).is_none(), "unexpected contract: {bad}");
        }
    }
    #[test]
    fn process_receipt_is_written_inside_tracked_child_and_is_one_shot() {
        let payload = tracked_payload("exec-123", &command()).unwrap().unwrap();
        assert!(payload.contains("mkdir -- '/tmp/opsark-receipt-exec-123' || exit 125"));
        assert!(payload.contains("mv -- \"$receipt.tmp\" \"$receipt\""));
        assert!(tracked_payload("bad/id", &command()).is_err());
        assert!(tracked_payload("exec-123", "touch /arbitrary").unwrap().is_none());
    }
}
