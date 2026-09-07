use crate::ssh::{connect_ssh, ssh_exec};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const BYTES_PER_MEBIBYTE: f64 = 1_048_576.0;
const REMOTE_METRICS_COMMAND: &str = r#"cpu=$(LC_ALL=C top -bn1 | awk '/Cpu/{print 100-$8;exit}'); mem=$(free | awk '/Mem:/{print $3*100/$2}'); disk=$(df -P / | awk 'NR==2{gsub(/%/,"",$5);print $5}'); net=$(awk -F'[: ]+' '/:/{rx+=$3;tx+=$11}END{print rx" "tx}' /proc/net/dev); echo "$cpu"; echo "$mem"; echo "$disk"; echo "$net""#;

type MetricSample = (f64, f64, Instant);

static METRIC_SAMPLES: OnceLock<Mutex<HashMap<String, MetricSample>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metrics {
    pub(crate) cpu: u8,
    pub(crate) memory: u8,
    pub(crate) disk: u8,
    pub(crate) network_in: f32,
    pub(crate) network_out: f32,
    pub(crate) sampled_at: String,
}

#[derive(Debug)]
struct ParsedRemoteMetrics {
    cpu: u8,
    memory: u8,
    disk: u8,
    network_totals: Option<(f64, f64)>,
}

fn parse_percentage(value: &str) -> u8 {
    value
        .trim()
        .parse::<f32>()
        .unwrap_or(0.0)
        .round()
        .clamp(0.0, 100.0) as u8
}

fn parse_remote_metrics(raw: &str) -> Result<ParsedRemoteMetrics, String> {
    let lines = raw.lines().collect::<Vec<_>>();
    if lines.len() < 4 {
        return Err("实时指标返回格式不完整".into());
    }
    let totals = lines[3]
        .split_whitespace()
        .filter_map(|value| value.parse::<f64>().ok())
        .collect::<Vec<_>>();
    Ok(ParsedRemoteMetrics {
        cpu: parse_percentage(lines[0]),
        memory: parse_percentage(lines[1]),
        disk: parse_percentage(lines[2]),
        network_totals: (totals.len() == 2).then(|| (totals[0], totals[1])),
    })
}

fn calculate_network_rates(
    previous: Option<(f64, f64)>,
    current: (f64, f64),
    elapsed_seconds: f64,
) -> (f32, f32) {
    let Some((previous_rx, previous_tx)) = previous else {
        return (0.0, 0.0);
    };
    let elapsed = elapsed_seconds.max(0.1);
    (
        ((current.0 - previous_rx).max(0.0) / BYTES_PER_MEBIBYTE / elapsed) as f32,
        ((current.1 - previous_tx).max(0.0) / BYTES_PER_MEBIBYTE / elapsed) as f32,
    )
}

fn sample_network_rates(
    sample_key: String,
    totals: Option<(f64, f64)>,
    now: Instant,
) -> Result<(f32, f32), String> {
    let Some(current) = totals else {
        return Ok((0.0, 0.0));
    };
    let samples = METRIC_SAMPLES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut samples = samples.lock().map_err(|_| "指标采样状态锁异常")?;
    let rates = samples.get(&sample_key).map(|(rx, tx, sampled_at)| {
        calculate_network_rates(
            Some((*rx, *tx)),
            current,
            now.duration_since(*sampled_at).as_secs_f64(),
        )
    });
    samples.insert(sample_key, (current.0, current.1, now));
    Ok(rates.unwrap_or((0.0, 0.0)))
}

#[tauri::command]
pub(crate) fn get_realtime_metrics() -> Metrics {
    let tick = crate::unix_seconds();
    Metrics {
        cpu: 22 + (tick % 26) as u8,
        memory: 49 + (tick % 11) as u8,
        disk: 68,
        network_in: 2.4 + (tick % 70) as f32 / 10.0,
        network_out: 0.8 + (tick % 28) as f32 / 10.0,
        sampled_at: tick.to_string(),
    }
}

#[tauri::command(async)]
pub(crate) fn get_ssh_metrics(
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<Metrics, String> {
    let session = connect_ssh(&host, port, &username, &password)?;
    let (raw, status) = ssh_exec(&session, REMOTE_METRICS_COMMAND)?;
    if status != 0 {
        return Err(format!("实时指标采集失败：{raw}"));
    }
    let parsed = parse_remote_metrics(&raw)?;
    let sample_key = format!("{username}@{host}:{port}");
    let (network_in, network_out) =
        sample_network_rates(sample_key, parsed.network_totals, Instant::now())?;
    Ok(Metrics {
        cpu: parsed.cpu,
        memory: parsed.memory,
        disk: parsed.disk,
        network_in,
        network_out,
        sampled_at: crate::unix_seconds().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rounds_and_clamps_percentages() {
        assert_eq!(parse_percentage("49.6"), 50);
        assert_eq!(parse_percentage("-2"), 0);
        assert_eq!(parse_percentage("130"), 100);
        assert_eq!(parse_percentage("invalid"), 0);
    }

    #[test]
    fn parses_remote_metrics_and_network_totals() {
        let parsed = parse_remote_metrics("12.4\n55.6\n80\n1048576 2097152").unwrap();
        assert_eq!(parsed.cpu, 12);
        assert_eq!(parsed.memory, 56);
        assert_eq!(parsed.disk, 80);
        assert_eq!(parsed.network_totals, Some((1_048_576.0, 2_097_152.0)));
    }

    #[test]
    fn rejects_incomplete_remote_output_and_ignores_invalid_totals() {
        assert_eq!(
            parse_remote_metrics("1\n2\n3").unwrap_err(),
            "实时指标返回格式不完整"
        );
        assert!(parse_remote_metrics("1\n2\n3\ninvalid")
            .unwrap()
            .network_totals
            .is_none());
    }

    #[test]
    fn calculates_rates_after_the_first_sample_without_negative_values() {
        assert_eq!(
            calculate_network_rates(None, (BYTES_PER_MEBIBYTE, BYTES_PER_MEBIBYTE), 1.0),
            (0.0, 0.0)
        );
        assert_eq!(
            calculate_network_rates(
                Some((BYTES_PER_MEBIBYTE, BYTES_PER_MEBIBYTE)),
                (3.0 * BYTES_PER_MEBIBYTE, 2.0 * BYTES_PER_MEBIBYTE),
                2.0,
            ),
            (1.0, 0.5)
        );
        assert_eq!(
            calculate_network_rates(Some((100.0, 100.0)), (50.0, 40.0), 1.0),
            (0.0, 0.0)
        );
    }
}
