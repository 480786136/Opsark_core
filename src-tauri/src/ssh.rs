use ssh2::Session;
use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

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
        .map_err(|_| "SSH 用户名或密码不正确".to_string())?;
    if !session.authenticated() {
        return Err("SSH 身份认证失败".into());
    }
    Ok(session)
}

/// Executes a command and combines non-empty stderr after stdout.
pub(crate) fn ssh_exec(session: &Session, command: &str) -> Result<(String, i32), String> {
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建 SSH 命令通道：{error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("无法执行远程命令：{error}"))?;
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
    Ok(format!(
        "pid_file={}; setsid sh -lc {} & child=$!; printf '%s' \"$child\" > \"$pid_file\"; wait \"$child\"; code=$?; rm -f \"$pid_file\"; exit \"$code\"",
        shell_quote(&pid_file),
        shell_quote(command),
    ))
}

/// Streams command output through a framework-neutral callback and supports cancellation.
pub(crate) fn ssh_exec_streaming<F>(
    session: &Session,
    execution_id: &str,
    command: &str,
    cancelled: &AtomicBool,
    mut on_output: F,
) -> Result<(String, i32), String>
where
    F: FnMut(String, &str),
{
    let wrapped = streaming_command(execution_id, command)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建 SSH 命令通道：{error}"))?;
    channel
        .exec(&wrapped)
        .map_err(|error| format!("无法执行远程命令：{error}"))?;
    session.set_blocking(false);
    let mut combined = String::new();
    let mut stdout_buffer = [0_u8; 8192];
    let mut stderr_buffer = [0_u8; 8192];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = channel.close();
            return Ok((combined.trim().to_string(), 130));
        }
        let mut received = false;
        match channel.read(&mut stdout_buffer) {
            Ok(size) if size > 0 => {
                received = true;
                let chunk = String::from_utf8_lossy(&stdout_buffer[..size]).to_string();
                combined.push_str(&chunk);
                on_output(chunk, "stdout");
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("读取远程标准输出失败：{error}")),
        }
        match channel.stderr().read(&mut stderr_buffer) {
            Ok(size) if size > 0 => {
                received = true;
                let chunk = String::from_utf8_lossy(&stderr_buffer[..size]).to_string();
                if !combined.is_empty() && !combined.ends_with('\n') {
                    combined.push('\n');
                }
                combined.push_str(&chunk);
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
        channel.exit_status().unwrap_or(1),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
