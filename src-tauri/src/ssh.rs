use ssh2::Session;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

const MAX_CAPTURED_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

// Compatibility ceiling for ssh2 0.9.6 / libssh2-sys 0.3.2's uncompressed
// transport. Recheck when upgrading the SDK. The exec request adds 18 bytes
// to the final command (including every shell/process-tracking wrapper).
const SSH_EXEC_PAYLOAD_LIMIT_EXCLUSIVE: usize = 34_744;
const SSH_EXEC_REQUEST_OVERHEAD_BYTES: usize = 18;
const SSH_EXEC_PREFLIGHT_PREFIX: &str = "OPSARK_SSH_EXEC_PREFLIGHT_V1:";

fn exec_payload_bytes(command_bytes: usize) -> Result<usize, String> {
    command_bytes
        .checked_add(SSH_EXEC_REQUEST_OVERHEAD_BYTES)
        .ok_or_else(|| "SSH exec 请求长度计算溢出".to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecPreflightDiagnostic {
    version: u8,
    origin: String,
    code: String,
    stage: String,
    dispatch_certainty: String,
    retryable: bool,
    payload_bytes: u64,
    payload_limit_exclusive: u64,
}

/// Interpret only an error from this module's native execution path. A remote
/// stdout frame or a libssh2 message is not evidence of local non-dispatch.
pub(crate) fn is_exec_payload_preflight_rejection(error: &str) -> bool {
    let Some(raw) = error.strip_prefix(SSH_EXEC_PREFLIGHT_PREFIX) else {
        return false;
    };
    let Ok(diagnostic) = serde_json::from_str::<ExecPreflightDiagnostic>(raw) else {
        return false;
    };
    diagnostic.version == 1
        && diagnostic.origin == "core"
        && diagnostic.code == "SSH_EXEC_PAYLOAD_TOO_LARGE"
        && diagnostic.stage == "exec_preflight"
        && diagnostic.dispatch_certainty == "not_dispatched"
        && !diagnostic.retryable
        && diagnostic.payload_limit_exclusive == SSH_EXEC_PAYLOAD_LIMIT_EXCLUSIVE as u64
        && diagnostic.payload_bytes >= SSH_EXEC_PAYLOAD_LIMIT_EXCLUSIVE as u64
        // The invoke consumer also requires an exactly representable integer.
        && diagnostic.payload_bytes <= 9_007_199_254_740_991
}

/// The closure owns all channel creation, PTY allocation and exec calls. Only
/// this local check can issue the not-dispatched envelope; errors returned by
/// the closure retain their original semantics, including libssh2's -34.
fn with_exec_payload_preflight<T>(
    command: &str,
    start: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    let payload_bytes = exec_payload_bytes(command.as_bytes().len())?;
    if payload_bytes >= SSH_EXEC_PAYLOAD_LIMIT_EXCLUSIVE {
        let diagnostic = serde_json::json!({
            "version": 1,
            "origin": "core",
            "code": "SSH_EXEC_PAYLOAD_TOO_LARGE",
            "stage": "exec_preflight",
            "dispatchCertainty": "not_dispatched",
            "retryable": false,
            "payloadBytes": payload_bytes,
            "payloadLimitExclusive": SSH_EXEC_PAYLOAD_LIMIT_EXCLUSIVE,
        });
        return Err(format!("{SSH_EXEC_PREFLIGHT_PREFIX}{diagnostic}"));
    }
    start(command)
}

/// Use libssh2's error codes, not the stage alone, to distinguish bad credentials
/// from a connection disappearing while authenticating. Never include inputs.
pub(crate) fn connection_error(stage: &str, error: &ssh2::Error) -> String {
    match error.code() {
        ssh2::ErrorCode::Session(-18 | -19 | -48) => {
            "SSH_AUTH_FAILED: SSH 身份认证失败，请检查用户名、密码或服务器认证设置".into()
        }
        ssh2::ErrorCode::Session(-15) => "SSH_AUTH_FAILED: SSH 密码已过期，请更新服务器凭据".into(),
        ssh2::ErrorCode::Session(-9 | -30) => {
            format!("SSH_TIMEOUT: {stage}超时")
        }
        ssh2::ErrorCode::Session(-2 | -3 | -7 | -13 | -43 | -45) => {
            format!(
                "SSH_NETWORK_ERROR: {stage}时网络连接中断（{}）",
                error.code()
            )
        }
        _ => format!("SSH_SESSION_ERROR: {stage}失败（{}）", error.code()),
    }
}

pub(crate) struct InteractivePromptCredential {
    pub(crate) kind: String,
    pub(crate) username: Option<String>,
    pub(crate) secret: String,
    pub(crate) target: Option<String>,
}

/// Sanitize before emitting events as well as before retaining evidence. A
/// remote program can re-enable echo or print a credential across read chunks.
struct CredentialOutputRedactor<'a> {
    values: Vec<&'a [u8]>,
    pending: Vec<u8>,
}

impl<'a> CredentialOutputRedactor<'a> {
    fn new(credential: &'a InteractivePromptCredential) -> Self {
        let mut values: Vec<&[u8]> = [
            Some(credential.secret.as_str()),
            credential.username.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .map(str::as_bytes)
        .collect();
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        Self {
            values,
            pending: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8], finish: bool) -> String {
        self.pending.extend_from_slice(chunk);
        let mut safe = Vec::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            let remaining = &self.pending[consumed..];
            if self
                .values
                .iter()
                .any(|value| value.starts_with(remaining) && value.len() > remaining.len())
            {
                if finish {
                    safe.extend_from_slice(b"[REDACTED]");
                    consumed = self.pending.len();
                }
                break;
            }
            if let Some(value) = self
                .values
                .iter()
                .find(|value| remaining.starts_with(value))
            {
                safe.extend_from_slice(b"[REDACTED]");
                consumed += value.len();
            } else {
                safe.push(self.pending[consumed]);
                consumed += 1;
            }
        }
        self.pending.drain(..consumed);
        String::from_utf8_lossy(&safe).into_owned()
    }
}

fn append_bounded_output(output: &mut String, chunk: &str) {
    output.push_str(chunk);
    if output.len() <= MAX_CAPTURED_OUTPUT_BYTES {
        return;
    }
    let desired = output.len() - MAX_CAPTURED_OUTPUT_BYTES;
    let drain_to = output
        .char_indices()
        .map(|(index, _)| index)
        .find(|index| *index >= desired)
        .unwrap_or(output.len());
    output.drain(..drain_to);
}

fn resolve_address(host: &str, port: u16) -> Result<SocketAddr, String> {
    format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| format!("无法解析服务器地址：{error}"))?
        .next()
        .ok_or_else(|| "服务器地址没有可用解析结果".to_string())
}

/// Creates an authenticated SSH session with bounded network timeouts.
pub(crate) fn connect_ssh(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> Result<Session, String> {
    let address = resolve_address(host, port)?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(10))
        .map_err(|error| format!("SSH 网络连接失败：{error}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(20))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(20))).ok();
    let mut session = Session::new().map_err(|error| format!("SSH 会话创建失败：{error}"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败：{error}"))?;
    session
        .userauth_password(username, password)
        .map_err(|error| connection_error("SSH 身份验证", &error))?;
    if !session.authenticated() {
        return Err("SSH_AUTH_FAILED: SSH 身份认证失败".into());
    }
    Ok(session)
}

/// Executes a command and combines non-empty stderr after stdout.
pub(crate) fn ssh_exec(session: &Session, command: &str) -> Result<(String, i32), String> {
    let mut channel = with_exec_payload_preflight(command, |checked_command| {
        let mut channel = session
            .channel_session()
            .map_err(|error| format!("无法创建 SSH 命令通道：{error}"))?;
        channel
            .exec(checked_command)
            .map_err(|error| format!("无法执行远程命令：{error}"))?;
        Ok(channel)
    })?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    channel
        .read_to_string(&mut stdout)
        .map_err(|error| error.to_string())?;
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|error| error.to_string())?;
    channel.wait_close().map_err(|error| error.to_string())?;
    let status = channel.exit_status().unwrap_or(1);
    if !stderr.trim().is_empty() {
        stdout.push('\n');
        stdout.push_str(stderr.trim());
    }
    Ok((stdout.trim().to_string(), status))
}

/// Quotes one value as a single POSIX shell argument.
pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Maps a validated execution identifier to its remote process-tracking file.
pub(crate) fn execution_pid_file(execution_id: &str) -> Result<String, String> {
    if execution_id.is_empty()
        || execution_id.len() > 160
        || !execution_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("执行标识不合法".into());
    }
    Ok(format!("/tmp/opsark-{execution_id}.pid"))
}

fn streaming_command(execution_id: &str, command: &str) -> Result<String, String> {
    let pid_file = execution_pid_file(execution_id)?;
    let payload = crate::bounded_file_reconciliation::tracked_payload(execution_id, command)?;
    Ok(format!(
        "pid_file={}; setsid sh -lc {} & child=$!; printf '%s' \"$child\" > \"$pid_file\"; wait \"$child\"; code=$?; rm -f \"$pid_file\"; exit \"$code\"",
        shell_quote(&pid_file),
        shell_quote(payload.as_deref().unwrap_or(command)),
    ))
}

/// SSH already owns a foreground session with a controlling terminal. Neither
/// setsid nor a background job is safe here: Git opens /dev/tty for credentials.
/// Track the existing process group so cancellation still includes descendants.
fn prompt_streaming_command(execution_id: &str, command: &str) -> Result<String, String> {
    let pid_file = execution_pid_file(execution_id)?;
    Ok(format!(
        "stty -echo || {{ printf '%s\\n' PTY_AUTH_CHANNEL_UNAVAILABLE >&2; exit 125; }}; pid_file={}; pgid=$(ps -o pgid= -p $$) || exit 125; pgid=$(printf '%s' \"$pgid\" | tr -d ' '); case \"$pgid\" in ''|*[!0-9]*|0|1) exit 125;; esac; (umask 077; printf '%s' \"$pgid\" > \"$pid_file\") || exit 125; trap 'rm -f \"$pid_file\"' EXIT; sh -c {}; code=$?; exit \"$code\"",
        shell_quote(&pid_file), shell_quote(command),
    ))
}

pub(crate) fn cancellation_command(execution_id: &str) -> Result<String, String> {
    let pid_file = execution_pid_file(execution_id)?;
    Ok(format!(
        r#"attempt=0
while ! test -s {0} && test "$attempt" -lt 20; do sleep 0.1; attempt=$((attempt + 1)); done
if test -s {0}; then
  pid=$(cat {0}) || exit 125
  case "$pid" in ''|*[!0-9]*) exit 125;; esac
  test "$pid" -gt 1 || exit 125
  processes=$(ps -eo pid=,ppid=) || exit 125
  descendants=$(printf '%s\n' "$processes" | awk -v root="$pid" '
    {{ parent[$1]=$2 }}
    END {{ for (p in parent) {{ q=p; depth=0;
      while (q in parent && q != root && q > 1 && depth++ < 10000) q=parent[q];
      if (q == root && p != root && p > 1) print p;
    }} }}') || exit 125
  kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for child in $descendants; do kill -TERM "$child" 2>/dev/null || true; done
  sleep 1
  kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  for child in $descendants; do kill -KILL "$child" 2>/dev/null || true; done
  rm -f {0}
fi"#,
        shell_quote(&pid_file),
    ))
}

/// Streams command output through a framework-neutral callback and supports cancellation.
#[derive(Default)]
struct CommandStreamCapture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
}
impl CommandStreamCapture {
    fn push(&mut self, bytes: &[u8], stderr: bool) {
        let buffer = if stderr { &mut self.stderr } else { &mut self.stdout };
        let remaining = MAX_CAPTURED_OUTPUT_BYTES.saturating_sub(buffer.len());
        if !stderr && bytes.len() > remaining { self.stdout_truncated = true; }
        buffer.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    }
}

#[cfg(test)]
mod stream_capture_tests {
    use super::*;

    #[test]
    fn stderr_progress_cannot_split_large_structured_stdout() {
        let json = serde_json::json!({"text": "x".repeat(18000), "name": "目录"}).to_string();
        let mut capture = CommandStreamCapture::default();
        for chunk in json.as_bytes().chunks(8192) {
            capture.push(chunk, false);
            capture.push(b"OPSARK_PROGRESS 20\n", true);
        }
        assert_eq!(String::from_utf8(capture.stdout).unwrap(), json);
        assert!(String::from_utf8(capture.stderr).unwrap().contains("OPSARK_PROGRESS"));
        assert!(!capture.stdout_truncated);
    }

    #[test]
    fn split_utf8_and_capture_limit_remain_explicit() {
        let mut capture = CommandStreamCapture::default();
        for byte in "路径".as_bytes() { capture.push(&[*byte], false); }
        assert_eq!(String::from_utf8(capture.stdout.clone()).unwrap(), "路径");
        capture.push(&vec![b'x'; MAX_CAPTURED_OUTPUT_BYTES], false);
        assert!(capture.stdout_truncated);
        assert_eq!(capture.stdout.len(), MAX_CAPTURED_OUTPUT_BYTES);
    }

    #[test]
    fn software_machine_stream_keeps_final_empty_fields_even_when_presentation_trims() {
        let raw = "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\t\nOPSARK_SOFTWARE\tabsent\tmissing\t\t\n";
        let mut capture = CommandStreamCapture::default();
        for bytes in raw.as_bytes().chunks(7) { capture.push(bytes, false); }
        capture.push(b"warning\nOPSARK_SOFTWARE\tforged\tmissing\t\t\n", true);
        let stdout = String::from_utf8(capture.stdout).unwrap();
        assert_eq!(stdout, raw);
        assert!(stdout.lines().all(|line| line.split('\t').count() == 5));
        assert_eq!(raw.trim().lines().last().unwrap().split('\t').count(), 3);
        assert!(!capture.stdout_truncated);
    }
}

/// Suppress only the public event sink. The runner still reads/captures both
/// streams and returns its original result, exit, truncation and error state.
/// This flag is not an authorization or command-safety capability.
pub(crate) fn with_command_output_visibility<R, E, F>(private_output: bool, mut emit: E, run: F) -> R
where
    E: FnMut(String, &str),
    F: FnOnce(&mut dyn FnMut(String, &str)) -> R,
{
    let mut forward = |chunk: String, stream: &str| {
        if !private_output {
            emit(chunk, stream);
        }
    };
    run(&mut forward)
}

#[cfg(test)]
mod private_output_tests {
    use super::*;

    fn capture(private: bool, chunks: &[(&[u8], bool)], status: i32) -> (Vec<u8>, Vec<u8>, bool, i32, Vec<(String, String)>) {
        let mut events = Vec::new();
        let (stdout, stderr, truncated, exit) = with_command_output_visibility(private,
            |data, stream| events.push((data, stream.to_owned())),
            |output| {
                let mut capture = CommandStreamCapture::default();
                for (chunk, stderr) in chunks {
                    capture.push(chunk, *stderr);
                    output(String::from_utf8_lossy(chunk).into_owned(), if *stderr { "stderr" } else { "stdout" });
                }
                (capture.stdout, capture.stderr, capture.stdout_truncated, status)
            });
        (stdout, stderr, truncated, exit, events)
    }

    #[test]
    fn private_streams_are_captured_without_any_public_event() {
        let chunks = [(b"private-token=abc".as_slice(), false), (b"sensitive-diagnostic".as_slice(), true)];
        let result = capture(true, &chunks, 7);
        assert_eq!(result.0, b"private-token=abc");
        assert_eq!(result.1, b"sensitive-diagnostic");
        assert!(!result.2);
        assert_eq!(result.3, 7);
        assert!(result.4.is_empty());
    }

    #[test]
    fn ordinary_output_preserves_both_streams_and_nonzero_exit() {
        let chunks = [(b"stdout".as_slice(), false), (b"stderr".as_slice(), true), (b"tail".as_slice(), false)];
        let public = capture(false, &chunks, 1);
        let private = capture(true, &chunks, 1);
        assert_eq!((&public.0, &public.1, public.2, public.3), (&private.0, &private.1, private.2, private.3));
        assert_eq!(public.4, vec![("stdout".into(), "stdout".into()), ("stderr".into(), "stderr".into()), ("tail".into(), "stdout".into())]);
    }

    #[test]
    fn privacy_does_not_change_capture_limits_or_split_utf8_receipts() {
        let utf8 = "路径".as_bytes();
        let huge = vec![b'x'; MAX_CAPTURED_OUTPUT_BYTES + 1];
        let chunks = [(utf8.get(..1).unwrap(), false), (utf8.get(1..).unwrap(), false), (huge.as_slice(), false), (b"progress".as_slice(), true)];
        let public = capture(false, &chunks, 0);
        let private = capture(true, &chunks, 0);
        assert_eq!((&public.0, &public.1, public.2, public.3), (&private.0, &private.1, private.2, private.3));
        assert!(private.0.starts_with(utf8));
        assert_eq!(private.0.len(), MAX_CAPTURED_OUTPUT_BYTES);
        assert!(private.2);
        assert_eq!(private.3, 0);
        assert!(private.4.is_empty());
        assert_eq!(public.4.len(), chunks.len());
    }

    #[test]
    fn cancel_receipt_keeps_exit_130_and_already_read_output() {
        let result = capture(true, &[(b"before cancellation".as_slice(), false)], 130);
        assert_eq!(result.3, 130);
        assert_eq!(result.0, b"before cancellation");
        assert!(result.4.is_empty());
    }

    #[test]
    fn transport_errors_are_returned_to_the_original_caller_without_emission() {
        let mut events = Vec::new();
        let result: Result<(), String> = with_command_output_visibility(true,
            |data, stream| events.push((data, stream.to_owned())),
            |output| {
                output("sensitive stderr".into(), "stderr");
                Err("transport-error-original".into())
            });
        assert_eq!(result.unwrap_err(), "transport-error-original");
        assert!(events.is_empty());
    }
}

/// Ordinary Shell callers retain the historical combined presentation.
pub(crate) fn ssh_exec_streaming<F>(session: &Session, execution_id: &str, command: &str,
    cancelled: &AtomicBool, on_output: F) -> Result<(String, i32), String>
where F: FnMut(String, &str),
{
    ssh_exec_streaming_separated(session, execution_id, command, cancelled, on_output)
        .map(|(combined, _, _, _, status)| (combined, status))
}

pub(crate) fn ssh_exec_streaming_separated<F>(
    session: &Session,
    execution_id: &str,
    command: &str,
    cancelled: &AtomicBool,
    mut on_output: F,
) -> Result<(String, String, String, bool, i32), String>
where
    F: FnMut(String, &str),
{
    let wrapped = streaming_command(execution_id, command)?;
    if cancelled.load(Ordering::Relaxed) {
        return Ok((String::new(), String::new(), String::new(), false, 130));
    }
    let mut channel = with_exec_payload_preflight(&wrapped, |checked_command| {
        let mut channel = session
            .channel_session()
            .map_err(|error| format!("无法创建 SSH 命令通道：{error}"))?;
        channel
            .exec(checked_command)
            .map_err(|error| format!("无法执行远程命令：{error}"))?;
        Ok(channel)
    })?;
    session.set_blocking(false);
    let mut combined = String::new();
    let mut streams = CommandStreamCapture::default();
    let mut stdout_buffer = [0_u8; 8192];
    let mut stderr_buffer = [0_u8; 8192];
    loop {
        // Cancellation kills the tracked group remotely. Closing the channel
        // first can remove its pid file before descendants have been killed.
        let mut received = false;
        match channel.read(&mut stdout_buffer) {
            Ok(size) if size > 0 => {
                received = true;
                streams.push(&stdout_buffer[..size], false);
                let chunk = String::from_utf8_lossy(&stdout_buffer[..size]).to_string();
                append_bounded_output(&mut combined, &chunk);
                on_output(chunk, "stdout");
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("读取远程标准输出失败：{error}")),
        }
        match channel.stderr().read(&mut stderr_buffer) {
            Ok(size) if size > 0 => {
                received = true;
                streams.push(&stderr_buffer[..size], true);
                let chunk = String::from_utf8_lossy(&stderr_buffer[..size]).to_string();
                if !combined.is_empty() && !combined.ends_with('\n') {
                    combined.push('\n');
                }
                append_bounded_output(&mut combined, &chunk);
                on_output(chunk, "stderr");
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("读取远程错误输出失败：{error}")),
        }
        if channel.eof() {
            break;
        }
        if !received {
            thread::sleep(Duration::from_millis(35));
        }
    }
    session.set_blocking(true);
    channel.wait_close().map_err(|error| error.to_string())?;
    Ok((
        combined.trim().to_string(),
        String::from_utf8_lossy(&streams.stdout).into_owned(),
        String::from_utf8_lossy(&streams.stderr).into_owned(),
        streams.stdout_truncated,
        if cancelled.load(Ordering::Relaxed) {
            130
        } else {
            channel.exit_status().unwrap_or(1)
        },
    ))
}

fn prompt_target_matches(buffer: &str, target: Option<&str>) -> bool {
    target.is_none_or(|target| {
        let normalized = target.trim().to_ascii_lowercase();
        normalized.is_empty() || buffer.to_ascii_lowercase().contains(&normalized)
    })
}

fn pending_prompt_response(
    tail: &str,
    credential: &InteractivePromptCredential,
    username_sent: bool,
    secret_sent: bool,
) -> Option<(&'static str, String)> {
    let lower = tail.to_ascii_lowercase();
    if !username_sent
        && credential.kind == "git-https"
        && lower.contains("username for '")
        && lower.trim_end().ends_with(':')
        && prompt_target_matches(tail, credential.target.as_deref())
    {
        return credential
            .username
            .as_ref()
            .map(|value| ("username", value.clone()));
    }
    if !secret_sent
        && (lower.contains("password for '") || lower.contains("password:"))
        && lower.trim_end().ends_with(':')
        && prompt_target_matches(tail, credential.target.as_deref())
    {
        return Some(("secret", credential.secret.clone()));
    }
    None
}

/// Executes one command in an independent SSH PTY while answering only the
/// explicitly bound username/password prompts. `stty -echo` prevents supplied
/// values from being reflected into output, logs, or model evidence.
pub(crate) fn ssh_exec_streaming_with_prompt<F>(
    session: &Session,
    execution_id: &str,
    command: &str,
    cancelled: &AtomicBool,
    credential: &InteractivePromptCredential,
    mut on_output: F,
) -> Result<(String, i32), String>
where
    F: FnMut(String, &str),
{
    let wrapped = prompt_streaming_command(execution_id, command)?;
    if cancelled.load(Ordering::Relaxed) {
        return Ok((String::new(), 130));
    }
    let mut channel = with_exec_payload_preflight(&wrapped, |checked_command| {
        let mut channel = session
            .channel_session()
            .map_err(|error| format!("无法创建 Agent SSH PTY 通道：{error}"))?;
        channel
            .request_pty("xterm", None, Some((120, 32, 0, 0)))
            .map_err(|error| format!("无法申请 Agent SSH PTY：{error}"))?;
        channel
            .exec(checked_command)
            .map_err(|error| format!("无法执行 Agent SSH PTY 命令：{error}"))?;
        Ok(channel)
    })?;
    session.set_blocking(false);
    let mut combined = String::new();
    let mut prompt_tail = String::new();
    let mut stdout_redactor = CredentialOutputRedactor::new(credential);
    let mut stderr_redactor = CredentialOutputRedactor::new(credential);
    let mut username_sent = false;
    let mut secret_sent = false;
    let mut stdout_buffer = [0_u8; 8192];
    let mut stderr_buffer = [0_u8; 8192];
    loop {
        // Wait for the cancellation RPC to kill the tracked group. Sending
        // Ctrl-C/closing first could clean the pid file while background children
        // (which may ignore SIGINT) survive, preventing the RPC from finding them.
        let mut received = false;
        for (stream, buffer) in [
            ("stdout", &mut stdout_buffer),
            ("stderr", &mut stderr_buffer),
        ] {
            let read = if stream == "stdout" {
                channel.read(buffer)
            } else {
                channel.stderr().read(buffer)
            };
            match read {
                Ok(size) if size > 0 => {
                    received = true;
                    let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
                    prompt_tail.push_str(&chunk);
                    if prompt_tail.len() > 2048 {
                        let keep_from = prompt_tail
                            .char_indices()
                            .map(|(index, _)| index)
                            .find(|index| *index >= prompt_tail.len() - 2048)
                            .unwrap_or(0);
                        prompt_tail.drain(..keep_from);
                    }
                    let safe = if stream == "stdout" {
                        stdout_redactor.push(&buffer[..size], false)
                    } else {
                        stderr_redactor.push(&buffer[..size], false)
                    };
                    append_bounded_output(&mut combined, &safe);
                    if !safe.is_empty() {
                        on_output(safe, stream);
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("读取 Agent SSH PTY 输出失败：{error}")),
            }
        }
        if let Some((role, value)) = (!cancelled.load(Ordering::Relaxed))
            .then(|| pending_prompt_response(&prompt_tail, credential, username_sent, secret_sent))
            .flatten()
        {
            session.set_blocking(true);
            channel
                .write_all(format!("{value}\n").as_bytes())
                .and_then(|_| channel.flush())
                .map_err(|error| format!("响应 Agent 认证提示失败：{error}"))?;
            session.set_blocking(false);
            if role == "username" {
                username_sent = true;
            } else {
                secret_sent = true;
            }
            prompt_tail.clear();
        }
        if channel.eof() {
            break;
        }
        if !received {
            thread::sleep(Duration::from_millis(35));
        }
    }
    for (stream, redactor) in [
        ("stdout", &mut stdout_redactor),
        ("stderr", &mut stderr_redactor),
    ] {
        let safe = redactor.push(b"", true);
        append_bounded_output(&mut combined, &safe);
        if !safe.is_empty() {
            on_output(safe, stream);
        }
    }
    session.set_blocking(true);
    channel.wait_close().map_err(|error| error.to_string())?;
    Ok((
        combined.trim().to_string(),
        if cancelled.load(Ordering::Relaxed) {
            130
        } else {
            channel.exit_status().unwrap_or(1)
        },
    ))
}

#[cfg(test)]
mod exec_preflight_tests {
    use super::*;

    #[derive(Clone, Copy, Debug)]
    enum Entry {
        Ordinary,
        Streaming,
        Separated,
        Prompt,
    }

    const ENTRIES: [Entry; 4] = [
        Entry::Ordinary,
        Entry::Streaming,
        Entry::Separated,
        Entry::Prompt,
    ];
    const EXECUTION_ID: &str = "exec-preflight-boundary";

    fn final_command(entry: Entry, command: &str) -> String {
        match entry {
            Entry::Ordinary => command.to_string(),
            Entry::Streaming | Entry::Separated => {
                streaming_command(EXECUTION_ID, command).unwrap()
            }
            Entry::Prompt => prompt_streaming_command(EXECUTION_ID, command).unwrap(),
        }
    }

    fn command_at_payload(entry: Entry, payload_bytes: usize) -> String {
        // The original argument is quoted once here and a second time by the
        // production streaming wrappers. ASCII padding has no quote expansion.
        let mut command = format!(
            "printf '%s' {} ",
            shell_quote("机密='single' \"double\" $HOME `echo unsafe` 😀")
        );
        let initial = exec_payload_bytes(final_command(entry, &command).len()).unwrap();
        command.push_str(&"x".repeat(payload_bytes.checked_sub(initial).unwrap()));
        assert_eq!(
            exec_payload_bytes(final_command(entry, &command).len()).unwrap(),
            payload_bytes
        );
        command
    }

    fn assert_diagnostic(error: &str, payload_bytes: usize) {
        let diagnostic: serde_json::Value = serde_json::from_str(
            error.strip_prefix(SSH_EXEC_PREFLIGHT_PREFIX).unwrap(),
        )
        .unwrap();
        assert_eq!(
            diagnostic,
            serde_json::json!({
                "version": 1,
                "origin": "core",
                "code": "SSH_EXEC_PAYLOAD_TOO_LARGE",
                "stage": "exec_preflight",
                "dispatchCertainty": "not_dispatched",
                "retryable": false,
                "payloadBytes": payload_bytes,
                "payloadLimitExclusive": 34_744,
            })
        );
        assert!(!error.contains("机密"));
        assert!(!error.contains(EXECUTION_ID));
    }

    #[test]
    fn final_utf8_and_nested_quotes_are_checked_before_any_fake_channel_side_effect() {
        for entry in ENTRIES {
            for payload_bytes in [34_743, 34_744, 34_745] {
                let command = command_at_payload(entry, payload_bytes);
                let wrapped = final_command(entry, &command);
                assert!(wrapped.len() > wrapped.chars().count());
                if !matches!(entry, Entry::Ordinary) {
                    assert!(command.len() + 18 < 34_744);
                    assert!(wrapped.contains("'\"'\"'"));
                }
                let mut opened = 0;
                let mut pty_requests = 0;
                let mut executed = Vec::new();
                let result = with_exec_payload_preflight(&wrapped, |checked_command| {
                    opened += 1;
                    if matches!(entry, Entry::Prompt) {
                        pty_requests += 1;
                    }
                    executed.push(checked_command.to_string());
                    Ok(())
                });
                if payload_bytes == 34_743 {
                    result.unwrap();
                    assert_eq!(opened, 1);
                    assert_eq!(pty_requests, usize::from(matches!(entry, Entry::Prompt)));
                    assert_eq!(executed, vec![wrapped]);
                } else {
                    assert_diagnostic(&result.unwrap_err(), payload_bytes);
                    assert_eq!((opened, pty_requests), (0, 0));
                    assert!(executed.is_empty());
                }
            }
        }
    }

    #[test]
    fn production_entries_reject_final_payload_before_touching_an_unconnected_session() {
        // Session has no TCP stream, handshake or authentication. Accepted
        // payloads fail opening a channel; rejected payloads must reach the
        // preflight envelope first. No real SSH connection is possible here.
        let session = Session::new().unwrap();
        let cancelled = AtomicBool::new(false);
        let credential = InteractivePromptCredential {
            kind: "git-https".into(),
            username: Some("synthetic-account".into()),
            secret: "synthetic-secret".into(),
            target: None,
        };
        for entry in ENTRIES {
            for payload_bytes in [34_743, 34_744, 34_745] {
                let command = command_at_payload(entry, payload_bytes);
                let mut outputs = 0;
                let error = match entry {
                    Entry::Ordinary => ssh_exec(&session, &command).unwrap_err(),
                    Entry::Streaming => ssh_exec_streaming(
                        &session, EXECUTION_ID, &command, &cancelled, |_, _| outputs += 1,
                    ).unwrap_err(),
                    Entry::Separated => ssh_exec_streaming_separated(
                        &session, EXECUTION_ID, &command, &cancelled, |_, _| outputs += 1,
                    ).unwrap_err(),
                    Entry::Prompt => ssh_exec_streaming_with_prompt(
                        &session, EXECUTION_ID, &command, &cancelled, &credential,
                        |_, _| outputs += 1,
                    ).unwrap_err(),
                };
                assert_eq!(outputs, 0);
                if payload_bytes == 34_743 {
                    assert!(error.starts_with("无法创建"), "{entry:?}: {error}");
                    assert!(!error.contains(SSH_EXEC_PREFLIGHT_PREFIX));
                } else {
                    assert_diagnostic(&error, payload_bytes);
                }
            }
        }
    }

    #[test]
    fn cancellation_keeps_existing_exit_130_before_payload_preflight() {
        let session = Session::new().unwrap();
        let cancelled = AtomicBool::new(true);
        let command = "x".repeat(34_744);
        let unexpected_output = |_: String, _: &str| panic!("cancelled before channel creation");
        assert_eq!(
            ssh_exec_streaming(&session, EXECUTION_ID, &command, &cancelled, unexpected_output).unwrap(),
            (String::new(), 130)
        );
        assert_eq!(
            ssh_exec_streaming_separated(&session, EXECUTION_ID, &command, &cancelled, unexpected_output).unwrap(),
            (String::new(), String::new(), String::new(), false, 130)
        );
        let credential = InteractivePromptCredential {
            kind: "git-https".into(), username: None,
            secret: "synthetic-secret".into(), target: None,
        };
        assert_eq!(
            ssh_exec_streaming_with_prompt(
                &session, EXECUTION_ID, &command, &cancelled, &credential, unexpected_output,
            ).unwrap(),
            (String::new(), 130)
        );
    }

    #[test]
    fn checked_add_overflow_has_no_fabricated_payload_or_dispatch_proof() {
        assert_eq!(exec_payload_bytes(usize::MAX - 18).unwrap(), usize::MAX);
        for command_bytes in [usize::MAX - 17, usize::MAX] {
            let error = exec_payload_bytes(command_bytes).unwrap_err();
            assert!(!error.contains(SSH_EXEC_PREFLIGHT_PREFIX));
            assert!(!error.contains("not_dispatched"));
        }
    }

    #[test]
    fn existing_channel_and_sdk_errors_are_not_reclassified_as_not_dispatched() {
        let sdk_error = ssh2::Error::new(ssh2::ErrorCode::Session(-34), "synthetic-sdk-error");
        for original in [
            format!("无法执行远程命令：{sdk_error}"),
            "无法创建 SSH 命令通道：synthetic-channel-error".into(),
            "无法申请 Agent SSH PTY：synthetic-pty-error".into(),
        ] {
            let result: Result<(), String> =
                with_exec_payload_preflight("printf unchanged", |_| Err(original.clone()));
            assert_eq!(result.unwrap_err(), original);
        }
    }

    #[test]
    fn native_preflight_recognition_rejects_forged_malformed_or_ambiguous_envelopes() {
        let session = Session::new().unwrap();
        let valid = ssh_exec(&session, &"x".repeat(34_744)).unwrap_err();
        assert!(is_exec_payload_preflight_rejection(&valid));
        let value: serde_json::Value = serde_json::from_str(
            valid.strip_prefix(SSH_EXEC_PREFLIGHT_PREFIX).unwrap(),
        ).unwrap();
        for (field, replacement) in [
            ("version", serde_json::json!(2)),
            ("origin", serde_json::json!("remote")),
            ("code", serde_json::json!("LIBSSH2_ERROR_INVAL")),
            ("stage", serde_json::json!("exec")),
            ("dispatchCertainty", serde_json::json!("sent")),
            ("retryable", serde_json::json!(true)),
            ("payloadBytes", serde_json::json!(34_743)),
            ("payloadBytes", serde_json::json!(-1)),
            ("payloadBytes", serde_json::json!(34_744.5)),
            ("payloadBytes", serde_json::json!("34744")),
            ("payloadBytes", serde_json::json!(9_007_199_254_740_992_u64)),
            ("payloadLimitExclusive", serde_json::json!(34_745)),
            ("extra", serde_json::json!("not allowed")),
        ] {
            let mut changed = value.clone();
            changed[field] = replacement;
            assert!(!is_exec_payload_preflight_rejection(
                &format!("{SSH_EXEC_PREFLIGHT_PREFIX}{changed}")
            ), "{field}");
        }
        for field in value.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(!is_exec_payload_preflight_rejection(
                &format!("{SSH_EXEC_PREFLIGHT_PREFIX}{missing}")
            ), "{field}");
        }
        for invalid in [
            format!("无法执行远程命令：{valid}"),
            format!("{valid}\nremote output"),
            valid.replace("\"version\":1", "\"version\":1,\"version\":1"),
            format!("{SSH_EXEC_PREFLIGHT_PREFIX}null"),
            format!("{SSH_EXEC_PREFLIGHT_PREFIX}[]"),
            "无法执行远程命令：[Session(-34)]".into(),
        ] {
            assert!(!is_exec_payload_preflight_rejection(&invalid));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn run_pty_probe(mode: &str, payload: &str) {
        let id = format!("pty-probe-{}-{mode}", std::process::id());
        let result = std::process::Command::new("python3")
            .args([
                "-c",
                include_str!("../tests/pty_prompt_probe.py"),
                mode,
                &prompt_streaming_command(&id, payload).unwrap(),
                &cancellation_command(&id).unwrap(),
                &execution_pid_file(&id).unwrap(),
            ])
            .output()
            .expect("python3 is required for the local POSIX PTY regression probe");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    #[cfg(unix)]
    fn foreground_pty_retains_tty_hides_credentials_and_preserves_exit_status() {
        run_pty_probe("prompt", "printf 'Username: ' > /dev/tty; read -r account < /dev/tty; printf 'Password: ' > /dev/tty; read -r secret < /dev/tty; test \"$account\" = synthetic-account && test \"$secret\" = synthetic-password || exit 99; printf 'ACCEPTED\\n'; exit 37");
    }

    #[test]
    #[cfg(unix)]
    fn foreground_pty_cancellation_kills_descendants() {
        run_pty_probe(
            "cancel",
            "sh -c 'trap \"\" TERM; sleep 120' & descendant=$!; printf 'READY:%s\\n' \"$descendant\"; wait \"$descendant\"",
        );
    }

    #[test]
    #[cfg(unix)]
    fn foreground_pty_cancellation_includes_interactive_job_groups() {
        let payload = format!("bash -ic {}", shell_quote("sh -c 'trap \"\" HUP TERM; sleep 120' & descendant=$!; printf 'READY:%s\\n' \"$descendant\"; wait \"$descendant\""));
        run_pty_probe("interactive-cancel", &payload);
    }

    #[test]
    #[cfg(unix)]
    fn prompt_execution_fails_closed_without_a_terminal() {
        let result = std::process::Command::new("sh")
            .args([
                "-c",
                &prompt_streaming_command("no-pty-probe", "printf SHOULD_NOT_RUN").unwrap(),
            ])
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(125));
        assert!(!String::from_utf8_lossy(&result.stdout).contains("SHOULD_NOT_RUN"));
        assert!(String::from_utf8_lossy(&result.stderr).contains("PTY_AUTH_CHANNEL_UNAVAILABLE"));
    }

    #[test]
    fn credential_redaction_survives_every_chunk_boundary() {
        let credential = InteractivePromptCredential {
            kind: "git-https".into(),
            username: Some("account".into()),
            secret: "secret-value".into(),
            target: None,
        };
        let output = "Username: account Password: secret-value done";
        for boundary in 0..=output.len() {
            let mut redactor = CredentialOutputRedactor::new(&credential);
            let first = redactor.push(&output.as_bytes()[..boundary], false);
            let second = redactor.push(&output.as_bytes()[boundary..], false);
            let tail = redactor.push(b"", true);
            assert_eq!(
                format!("{first}{second}{tail}"),
                "Username: [REDACTED] Password: [REDACTED] done"
            );
        }
        let unicode = InteractivePromptCredential {
            secret: "秘密值".into(),
            ..credential
        };
        let mut redactor = CredentialOutputRedactor::new(&unicode);
        let mut output = String::new();
        for byte in "秘密值".as_bytes() {
            output.push_str(&redactor.push(&[*byte], false));
        }
        output.push_str(&redactor.push(b"", true));
        assert_eq!(output, "[REDACTED]");
    }

    #[test]
    fn authentication_errors_do_not_mislabel_network_failures_or_expose_inputs() {
        for (code, prefix) in [
            (-18, "SSH_AUTH_FAILED:"),
            (-15, "SSH_AUTH_FAILED:"),
            (-9, "SSH_TIMEOUT:"),
            (-30, "SSH_TIMEOUT:"),
            (-13, "SSH_NETWORK_ERROR:"),
            (-43, "SSH_NETWORK_ERROR:"),
            (-33, "SSH_SESSION_ERROR:"),
        ] {
            let error = ssh2::Error::new(ssh2::ErrorCode::Session(code), "untrusted secret");
            let message = connection_error("SSH 身份验证", &error);
            assert!(message.starts_with(prefix), "{message}");
            assert!(!message.contains("untrusted secret"));
        }
    }

    #[test]
    fn quotes_posix_shell_arguments_without_interpolation() {
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("plain value"), "'plain value'");
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
    }

    #[test]
    fn validates_execution_identifiers_before_building_pid_paths() {
        assert_eq!(
            execution_pid_file("exec_123-safe").unwrap(),
            "/tmp/opsark-exec_123-safe.pid"
        );
        for invalid in ["", "../escape", "with space", "中文", &"a".repeat(161)] {
            assert_eq!(execution_pid_file(invalid).unwrap_err(), "执行标识不合法");
        }
    }

    #[test]
    fn wraps_streaming_commands_with_quoted_pid_and_payload() {
        let wrapped = streaming_command("exec-1", "printf '%s' \"$HOME\"").unwrap();
        assert!(wrapped.contains("pid_file='/tmp/opsark-exec-1.pid'"));
        assert!(wrapped.contains("setsid sh -lc 'printf '"));
        assert!(wrapped.contains("'\"'\"'"));
    }

    #[test]
    fn maps_invalid_addresses_without_opening_a_network_connection() {
        let error = resolve_address("\0", 22).unwrap_err();
        assert!(error.starts_with("无法解析服务器地址："));
    }

    #[test]
    fn bounds_captured_output_on_utf8_boundaries() {
        let mut output = "中".repeat(MAX_CAPTURED_OUTPUT_BYTES / 3 + 50);
        append_bounded_output(&mut output, "文");
        assert!(output.len() <= MAX_CAPTURED_OUTPUT_BYTES + 3);
        assert!(output.is_char_boundary(0));
        assert!(output.ends_with("文"));
    }

    #[test]
    fn only_answers_bound_interactive_prompts_once() {
        let credential = InteractivePromptCredential {
            kind: "git-https".into(),
            username: Some("developer@example.com".into()),
            secret: "private".into(),
            target: Some("gitee.com".into()),
        };
        assert_eq!(
            pending_prompt_response(
                "Username for 'https://gitee.com': ",
                &credential,
                false,
                false
            ),
            Some(("username", "developer@example.com".into())),
        );
        assert!(pending_prompt_response(
            "Username for 'https://other.test': ",
            &credential,
            false,
            false
        )
        .is_none());
        assert_eq!(
            pending_prompt_response(
                "Password for 'https://developer@gitee.com': ",
                &credential,
                true,
                false
            ),
            Some(("secret", "private".into())),
        );
        assert!(pending_prompt_response("Password: ", &credential, true, true).is_none());
    }
}
