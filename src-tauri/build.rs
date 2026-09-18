fn main() {
    println!("cargo:rerun-if-env-changed=OPSARK_PLATFORM_URL");
    tauri_build::build()
}
