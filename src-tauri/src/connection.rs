//! A bounded, lightweight readiness probe. This uses its own short-lived SSH
//! session, so its deadline cannot interrupt an idle terminal or a long command.

use crate::ssh::connection_error;
use ssh2::{ErrorCode, Session};
use std::io::{self, Read};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{mpsc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MIN_TIMEOUT_MS: u64 = 250;
const MAX_TIMEOUT_MS: u64 = 30_000;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const MAX_QUEUED_RESOLUTIONS: usize = 32;

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(timeout_ms: Option<u64>) -> Self {
        Self(
            Instant::now()
                + Duration::from_millis(
                    timeout_ms
                        .unwrap_or(DEFAULT_TIMEOUT_MS)
                        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
                ),
        )
    }

    fn remaining(self, stage: &str) -> Result<Duration, String> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| format!("SSH_TIMEOUT: {stage}超时，请检查网络或服务器状态"))
    }

    fn wait(self, stage: &str) -> Result<(), String> {
        thread::sleep(self.remaining(stage)?.min(POLL_INTERVAL));
        self.remaining(stage).map(|_| ())
    }

    fn retry<T>(
        self,
        stage: &str,
        mut operation: impl FnMut() -> Result<T, ssh2::Error>,
    ) -> Result<T, String> {
        loop {
            self.remaining(stage)?;
            match operation() {
                Ok(value) => {
                    self.remaining(stage)?;
                    return Ok(value);
                }
                Err(error) if error.code() == ErrorCode::Session(-37) => self.wait(stage)?,
                Err(error) => return Err(connection_error(stage, &error)),
            }
        }
    }
}

type Addresses = Result<Vec<SocketAddr>, String>;

struct ResolveRequest {
    host: String,
    port: u16,
    deadline: Deadline,
    result: mpsc::SyncSender<Addresses>,
}

// The OS resolver cannot be cancelled portably. One process-wide worker and a
// bounded queue cap resources even if it stalls. Timed-out queued work
// is discarded. Unlike spawn_blocking per lookup, repeated probes never create
// an unbounded number of abandoned DNS jobs/threads. IP addresses bypass it.
static RESOLVER: OnceLock<Result<mpsc::SyncSender<ResolveRequest>, String>> = OnceLock::new();

fn resolve_requests(
    receiver: mpsc::Receiver<ResolveRequest>,
    mut lookup: impl FnMut(&str, u16) -> Addresses,
) {
    while let Ok(request) = receiver.recv() {
        if request.deadline.remaining("解析服务器地址").is_err() {
            continue;
        }
        let addresses = lookup(&request.host, request.port);
        let _ = request.result.try_send(addresses);
    }
}

fn resolver() -> Result<&'static mpsc::SyncSender<ResolveRequest>, String> {
    RESOLVER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel::<ResolveRequest>(MAX_QUEUED_RESOLUTIONS);
            thread::Builder::new()
                .name("opsark-ssh-resolver".into())
                .spawn(move || {
                    resolve_requests(receiver, |host, port| {
                        (host, port)
                            .to_socket_addrs()
                            .map(|addresses| addresses.take(16).collect::<Vec<_>>())
                            .map_err(|_| {
                                "SSH_NETWORK_ERROR: 无法解析服务器地址，请检查主机名和 DNS 设置"
                                    .into()
                            })
                    });
                })
                .map_err(|_| "SSH_NETWORK_ERROR: 无法启动地址解析服务".to_string())?;
            Ok(sender)
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn resolve(host: &str, port: u16, deadline: Deadline) -> Addresses {
    deadline.remaining("解析服务器地址")?;
    let host = host.trim();
    // Accept both raw IPv6 and [IPv6], without interpreting a URL as a host.
    let bare_host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare_host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    resolver()?
        .try_send(ResolveRequest {
            host: host.into(),
            port,
            deadline,
            result: sender,
        })
        .map_err(|_| "SSH_NETWORK_ERROR: 地址解析服务正忙，请稍后重试".to_string())?;
    await_resolution(receiver, deadline)
}

fn await_resolution(receiver: mpsc::Receiver<Addresses>, deadline: Deadline) -> Addresses {
    let addresses = receiver
        .recv_timeout(deadline.remaining("解析服务器地址")?)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => "SSH_TIMEOUT: 解析服务器地址超时".to_string(),
            mpsc::RecvTimeoutError::Disconnected => {
                "SSH_NETWORK_ERROR: 地址解析服务不可用".to_string()
            }
        })??;
    deadline.remaining("解析服务器地址")?;
    if addresses.is_empty() {
        return Err("SSH_NETWORK_ERROR: 服务器地址没有可用解析结果".into());
    }
    Ok(addresses)
}

fn io_error(stage: &str, error: io::Error) -> String {
    let code = if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        "SSH_TIMEOUT"
    } else {
        "SSH_NETWORK_ERROR"
    };
    format!("{code}: {stage}失败（{error}）")
}

fn validate_config(host: &str, port: u16, username: &str) -> Result<(), String> {
    if host.trim().is_empty()
        || host
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || host.contains('/')
        || host.contains('@')
        || port == 0
        || username.trim().is_empty()
        || username.contains('\0')
    {
        return Err("SSH_INVALID_CONFIG: 请检查服务器地址、端口和用户名".into());
    }
    Ok(())
}

fn probe(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    deadline: Deadline,
) -> Result<(), String> {
    validate_config(host, port, username)?;
    let addresses = resolve(host, port, deadline)?;
    let mut connected = None;
    let mut last_error = "SSH_NETWORK_ERROR: 无法连接服务器".to_string();
    for (index, address) in addresses.iter().enumerate() {
        // Divide remaining time between candidates so an unreachable IPv6
        // result cannot consume the entire budget before a usable IPv4 result.
        let remaining = deadline.remaining("建立 SSH 网络连接")?;
        let attempt_timeout = remaining / ((addresses.len() - index) as u32);
        match TcpStream::connect_timeout(address, attempt_timeout) {
            Ok(tcp) => {
                connected = Some(tcp);
                break;
            }
            Err(error) => last_error = io_error("建立 SSH 网络连接", error),
        }
    }
    let tcp = connected.ok_or(last_error)?;
    let remaining = deadline.remaining("准备 SSH 会话")?;
    tcp.set_read_timeout(Some(remaining))
        .map_err(|error| io_error("配置 SSH 读取时限", error))?;
    tcp.set_write_timeout(Some(remaining))
        .map_err(|error| io_error("配置 SSH 写入时限", error))?;
    tcp.set_nonblocking(true)
        .map_err(|error| io_error("配置 SSH 非阻塞连接", error))?;
    let mut session = Session::new().map_err(|error| connection_error("创建 SSH 会话", &error))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(remaining.as_millis().clamp(1, u32::MAX as u128) as u32);
    // Every protocol operation remains nonblocking and shares the one deadline.
    // Session::set_timeout alone would only bound each individual blocking call.
    session.set_blocking(false);
    deadline.retry("SSH 握手", || session.handshake())?;
    deadline.retry("SSH 身份验证", || {
        session.userauth_password(username, password)
    })?;
    if !session.authenticated() {
        return Err("SSH_AUTH_FAILED: SSH 身份认证失败".into());
    }
    let mut channel = deadline.retry("准备 SSH 命令通道", || session.channel_session())?;
    deadline.retry("验证 SSH 会话响应", || channel.exec("true"))?;
    let mut buffer = [0_u8; 1024];
    loop {
        deadline.remaining("等待 SSH 会话响应")?;
        for result in [
            channel.read(&mut buffer),
            channel.stderr().read(&mut buffer),
        ] {
            match result {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(io_error("读取 SSH 会话响应", error)),
            }
        }
        if channel.eof() {
            break;
        }
        deadline.wait("等待 SSH 会话响应")?;
    }
    deadline.retry("确认 SSH 会话响应", || channel.wait_close())?;
    let status = channel
        .exit_status()
        .map_err(|error| connection_error("读取 SSH 验证结果", &error))?;
    deadline.remaining("确认 SSH 会话响应")?;
    if status != 0 {
        return Err(format!(
            "SSH_SESSION_ERROR: SSH 验证命令未成功（退出码 {status}），请检查账户 Shell 权限"
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn check_ssh_connection(
    host: String,
    port: u16,
    username: String,
    password: String,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    // Include blocking-pool queue time in the budget. A late-started job checks
    // this deadline before doing DNS/network work instead of becoming a zombie.
    let deadline = Deadline::new(timeout_ms);
    let remaining = deadline.remaining("等待 SSH 连接检查")?;
    let task = tauri::async_runtime::spawn_blocking(move || {
        probe(&host, port, &username, &password, deadline)
    });
    tokio::time::timeout(remaining, task)
        .await
        .map_err(|_| "SSH_TIMEOUT: SSH 连接检查超时，请检查网络或服务器状态".to_string())?
        .map_err(|_| "SSH_SESSION_ERROR: SSH 连接检查任务异常结束".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_is_clamped_and_expired_deadline_prevents_work() {
        assert!(Deadline::new(None).remaining("测试").unwrap() <= Duration::from_secs(5));
        assert!(Deadline::new(Some(0)).remaining("测试").unwrap() <= Duration::from_millis(250));
        assert!(
            Deadline::new(Some(u64::MAX)).remaining("测试").unwrap() <= Duration::from_secs(30)
        );
        let expired = Deadline(Instant::now() - Duration::from_secs(1));
        let mut called = false;
        let error = expired.retry("测试", || {
            called = true;
            Ok(())
        });
        assert!(error.unwrap_err().starts_with("SSH_TIMEOUT:"));
        assert!(!called);
        assert!(resolve("127.0.0.1", 22, expired)
            .unwrap_err()
            .starts_with("SSH_TIMEOUT:"));
    }

    #[test]
    fn numeric_addresses_bypass_dns_including_ipv6() {
        for (host, expected) in [
            ("127.0.0.1", "127.0.0.1:22"),
            ("::1", "[::1]:22"),
            ("[::1]", "[::1]:22"),
        ] {
            assert_eq!(
                resolve(host, 22, Deadline::new(None)).unwrap(),
                vec![expected.parse::<SocketAddr>().unwrap()]
            );
        }
    }

    #[test]
    fn rejects_invalid_configuration_before_any_network_work() {
        for host in [
            "",
            "\0",
            "https://example.com",
            "user@example.com",
            "bad host",
        ] {
            let error = probe(host, 22, "user", "secret", Deadline::new(None)).unwrap_err();
            assert!(error.starts_with("SSH_INVALID_CONFIG:"));
            assert!(!error.contains("secret"));
        }
        assert!(validate_config("127.0.0.1", 0, "user").is_err());
        assert!(validate_config("127.0.0.1", 22, "").is_err());
    }

    #[test]
    fn nonblocking_retries_share_one_deadline_and_stop() {
        let deadline = Deadline(Instant::now() + Duration::from_millis(20));
        let started = Instant::now();
        let mut attempts = 0;
        let result: Result<(), String> = deadline.retry("测试响应", || {
            attempts += 1;
            Err(ssh2::Error::from_errno(ErrorCode::Session(-37)))
        });
        assert!(result.unwrap_err().starts_with("SSH_TIMEOUT:"));
        assert!(attempts > 0);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn does_not_retry_authentication_errors() {
        let mut attempts = 0;
        let result: Result<(), String> = Deadline::new(None).retry("SSH 身份验证", || {
            attempts += 1;
            Err(ssh2::Error::from_errno(ErrorCode::Session(-18)))
        });
        assert!(result.unwrap_err().starts_with("SSH_AUTH_FAILED:"));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn stalled_resolver_does_not_extend_callers_deadline() {
        let (_sender, receiver) = mpsc::sync_channel::<Addresses>(1);
        let started = Instant::now();
        let deadline = Deadline(started + Duration::from_millis(20));
        let error = await_resolution(receiver, deadline).unwrap_err();
        assert!(error.starts_with("SSH_TIMEOUT:"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn expired_queued_dns_jobs_are_discarded_without_lookup() {
        let (sender, receiver) = mpsc::sync_channel::<ResolveRequest>(2);
        let (expired_sender, expired_result) = mpsc::sync_channel(1);
        let (valid_sender, valid_result) = mpsc::sync_channel(1);
        for (host, deadline, result) in [
            (
                "expired",
                Deadline(Instant::now() - Duration::from_secs(1)),
                expired_sender,
            ),
            ("valid", Deadline::new(None), valid_sender),
        ] {
            sender
                .try_send(ResolveRequest {
                    host: host.into(),
                    port: 22,
                    deadline,
                    result,
                })
                .unwrap();
        }
        drop(sender);
        let mut lookups = Vec::new();
        resolve_requests(receiver, |host, _port| {
            lookups.push(host.to_string());
            Ok(vec!["127.0.0.1:22".parse().unwrap()])
        });
        assert_eq!(lookups, ["valid"]);
        assert!(expired_result.recv().is_err());
        assert_eq!(valid_result.recv().unwrap().unwrap().len(), 1);
    }
}
