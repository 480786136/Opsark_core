use super::*;
use std::io::{Read, Write};

#[derive(Clone)]
struct LiveSshConfig {
    host: String,
    port: u16,
    user: String,
    password: String,
}

impl LiveSshConfig {
    fn from_env() -> Self {
        let port = std::env::var("OPSARK_TEST_SSH_PORT")
            .unwrap_or_else(|_| "22".into())
            .parse::<u16>()
            .expect("OPSARK_TEST_SSH_PORT must be a valid TCP port");
        Self {
            host: required_env("OPSARK_TEST_SSH_HOST"),
            port,
            user: required_env("OPSARK_TEST_SSH_USER"),
            password: required_env("OPSARK_TEST_SSH_PASSWORD"),
        }
    }
}

struct SftpCleanup {
    config: LiveSshConfig,
    directory: String,
    files: Vec<String>,
    active: bool,
}

impl SftpCleanup {
    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for SftpCleanup {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        for path in self.files.iter().rev() {
            let _ = delete_sftp_entry(
                self.config.host.clone(),
                self.config.port,
                self.config.user.clone(),
                self.config.password.clone(),
                path.clone(),
                "file".into(),
            );
        }
        let _ = delete_sftp_entry(
            self.config.host.clone(),
            self.config.port,
            self.config.user.clone(),
            self.config.password.clone(),
            self.directory.clone(),
            "directory".into(),
        );
    }
}

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing required environment variable {name}"))
}

#[test]
#[ignore = "requires explicitly supplied live SSH credentials"]
fn probe_live_ssh_adapter() {
    let config = LiveSshConfig::from_env();
    let probe = probe_ssh_server(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
    )
    .expect("SSH probe failed");
    assert!(probe.info.cores > 0);
    assert!(probe.info.memory_gb > 0);
    assert!(probe.info.disk_gb > 0);
    assert!(!probe.info.os.is_empty());
    let files = list_sftp_directory(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
        "/".into(),
    )
    .expect("SFTP list failed");
    assert!(!files.is_empty());
    let metrics = get_ssh_metrics(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
    )
    .expect("metrics collection failed");
    assert!(metrics.disk > 0);
    let command_session = connect_ssh(&config.host, config.port, &config.user, &config.password)
        .expect("SSH command connection failed");
    let (command_output, command_status) =
        ssh_exec(&command_session, "printf OPSARK_SSH_OK").expect("SSH command failed");
    assert_eq!(command_status, 0);
    assert!(command_output.contains("OPSARK_SSH_OK"));
    let pty_session = connect_ssh(&config.host, config.port, &config.user, &config.password)
        .expect("PTY SSH connection failed");
    let mut pty = pty_session.channel_session().expect("PTY channel failed");
    pty.request_pty("xterm-256color", None, Some((120, 32, 0, 0)))
        .expect("PTY request failed");
    pty.shell().expect("PTY shell failed");
    pty.write_all(b"printf OPSARK_PTY_OK\nexit\n")
        .expect("PTY input failed");
    pty.flush().ok();
    let mut pty_output = String::new();
    pty.read_to_string(&mut pty_output)
        .expect("PTY output failed");
    assert!(pty_output.contains("OPSARK_PTY_OK"));

    let test_dir = format!("/tmp/opsark-sftp-test-{}", unix_seconds());
    let file_path = format!("{test_dir}/hello.txt");
    let renamed_path = format!("{test_dir}/renamed.txt");
    let mut cleanup = SftpCleanup {
        config: config.clone(),
        directory: test_dir.clone(),
        files: vec![file_path.clone(), renamed_path.clone()],
        active: true,
    };
    create_sftp_directory(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
        test_dir.clone(),
    )
    .expect("SFTP mkdir failed");
    write_sftp_file(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
        file_path.clone(),
        b"OPSARK_SFTP_OK".to_vec(),
    )
    .expect("SFTP upload failed");
    let downloaded = read_sftp_file(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
        file_path.clone(),
    )
    .expect("SFTP download failed");
    assert_eq!(downloaded, b"OPSARK_SFTP_OK");
    rename_sftp_entry(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
        file_path,
        renamed_path.clone(),
    )
    .expect("SFTP rename failed");
    delete_sftp_entry(
        config.host.clone(),
        config.port,
        config.user.clone(),
        config.password.clone(),
        renamed_path,
        "file".into(),
    )
    .expect("SFTP file delete failed");
    delete_sftp_entry(
        config.host,
        config.port,
        config.user,
        config.password,
        test_dir,
        "directory".into(),
    )
    .expect("SFTP directory delete failed");
    cleanup.disarm();
}

#[test]
#[ignore = "requires an explicitly supplied live model API key"]
fn generate_live_deepseek_plan() {
    let api_key = required_env("OPSARK_TEST_MODEL_KEY");
    let endpoint = std::env::var("OPSARK_TEST_MODEL_ENDPOINT")
        .unwrap_or_else(|_| "https://api.deepseek.com".into());
    let model =
        std::env::var("OPSARK_TEST_MODEL_NAME").unwrap_or_else(|_| "deepseek-v4-flash".into());
    let plan = tauri::async_runtime::block_on(generate_ai_plan(
        api_key,
        endpoint,
        model,
        "只读检查服务器磁盘空间".into(),
        r#"{"os":"CentOS 7","diskUsage":"82%","permission":"safe"}"#.into(),
        None,
    ))
    .expect("DeepSeek plan generation failed");
    assert!(!plan.is_empty());
    assert!(plan.iter().all(|step| !step.command.trim().is_empty()));
}
