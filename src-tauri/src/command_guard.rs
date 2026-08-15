pub(crate) fn risk_for(command: &str) -> &'static str {
    let lower = command.to_lowercase();
    if [
        "rm -rf",
        "mkfs",
        "fdisk",
        "userdel",
        "drop table",
        "iptables -f",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        "high"
    } else if [
        "install",
        "restart",
        "reload",
        "chmod",
        "chown",
        "apt ",
        "docker run",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        "medium"
    } else {
        "low"
    }
}

pub(crate) fn requires_high_risk_approval(command: &str) -> bool {
    risk_for(command) == "high"
}

#[cfg(test)]
mod tests {
    use super::{requires_high_risk_approval, risk_for};

    #[test]
    fn classifies_commands_by_highest_known_risk() {
        assert_eq!(risk_for("uname -a"), "low");
        assert_eq!(risk_for("systemctl restart app"), "medium");
        assert_eq!(risk_for("rm -rf /tmp/target"), "high");
        assert!(requires_high_risk_approval("DROP TABLE users"));
    }
}
