#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum ChangeOperation {
    PackageInstall,
    PackageRemove,
    AccountDelete,
    ServiceChange,
    ServiceDisable,
    ResourceDelete,
    NetworkPolicyChange,
    FileReplace,
}

pub(crate) fn change_operations(command: &str) -> Vec<ChangeOperation> {
    let lower = format!(" {} ", command.to_ascii_lowercase().replace('\n', " ; "));
    let mut operations = Vec::new();
    let package_manager = [
        " apt ",
        " apt-get ",
        " dnf ",
        " yum ",
        " zypper ",
        " pacman ",
    ]
    .iter()
    .any(|token| lower.contains(token));
    if package_manager
        && [" install ", " add ", " update ", " upgrade "]
            .iter()
            .any(|token| lower.contains(token))
    {
        operations.push(ChangeOperation::PackageInstall);
    }
    if (package_manager
        && [" remove ", " erase ", " purge ", " autoremove "]
            .iter()
            .any(|token| lower.contains(token)))
        || lower.contains(" npm uninstall ")
        || lower.contains(" pip uninstall ")
    {
        operations.push(ChangeOperation::PackageRemove);
    }
    if lower.contains(" userdel ") || lower.contains(" deluser ") {
        operations.push(ChangeOperation::AccountDelete);
    }
    if lower.contains(" systemctl disable ") || lower.contains(" systemctl mask ") {
        operations.push(ChangeOperation::ServiceDisable);
    } else if [
        " systemctl start ",
        " systemctl stop ",
        " systemctl restart ",
        " systemctl reload ",
    ]
    .iter()
    .any(|token| lower.contains(token))
    {
        operations.push(ChangeOperation::ServiceChange);
    }
    if lower.contains(" rm ") || lower.contains(" docker rm ") || lower.contains(" kubectl delete ")
    {
        operations.push(ChangeOperation::ResourceDelete);
    }
    if [" iptables ", " nft ", " ufw ", " firewall-cmd "]
        .iter()
        .any(|token| lower.contains(token))
    {
        operations.push(ChangeOperation::NetworkPolicyChange);
    }
    if lower.contains(" sed -i ")
        || lower.contains(" truncate ")
        || lower.contains(" tee ")
        || lower.contains(" >/")
    {
        operations.push(ChangeOperation::FileReplace);
    }
    operations.sort();
    operations.dedup();
    operations
}

pub(crate) fn risk_for(command: &str) -> &'static str {
    let lower = command.to_ascii_lowercase();
    let operations = change_operations(command);
    if operations.iter().any(|operation| {
        matches!(
            operation,
            ChangeOperation::AccountDelete | ChangeOperation::NetworkPolicyChange
        )
    }) || lower.contains("rm -rf")
        || lower.contains("mkfs")
        || lower.contains("fdisk")
        || lower.contains("drop table")
        || (operations.contains(&ChangeOperation::PackageRemove)
            && ["node", "npm", "python", "openssh", "systemd", "kernel"]
                .iter()
                .any(|name| lower.contains(name)))
        || (operations.contains(&ChangeOperation::ServiceDisable)
            && ["ssh", "network", "firewalld"]
                .iter()
                .any(|name| lower.contains(name)))
    {
        "high"
    } else if !operations.is_empty()
        || lower.contains("chmod")
        || lower.contains("chown")
        || lower.contains("docker run")
    {
        "medium"
    } else {
        "low"
    }
}

#[cfg(test)]
pub(crate) fn requires_high_risk_approval(command: &str) -> bool {
    risk_for(command) == "high"
}

#[cfg(test)]
mod tests {
    use super::{change_operations, requires_high_risk_approval, risk_for, ChangeOperation};

    #[test]
    fn classifies_commands_by_highest_known_risk() {
        assert_eq!(risk_for("uname -a"), "low");
        assert_eq!(risk_for("systemctl restart app"), "medium");
        assert_eq!(risk_for("rm -rf /tmp/target"), "high");
        assert!(requires_high_risk_approval("DROP TABLE users"));
    }

    #[test]
    fn classifies_semantic_destructive_operations() {
        assert!(
            change_operations("dnf remove nodejs npm").contains(&ChangeOperation::PackageRemove)
        );
        assert_eq!(risk_for("dnf remove nodejs npm"), "high");
        assert!(
            change_operations("systemctl disable app").contains(&ChangeOperation::ServiceDisable)
        );
        assert_eq!(risk_for("systemctl disable app"), "medium");
        assert_eq!(risk_for("iptables -F"), "high");
        assert_eq!(risk_for("userdel deploy"), "high");
        assert_eq!(risk_for("sed -i s/a/b/ /etc/app.conf"), "medium");
    }
}
