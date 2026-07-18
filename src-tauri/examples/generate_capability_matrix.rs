use std::env;
use std::fs;
use std::path::PathBuf;
use tabler_lib::database::capabilities::all_driver_capabilities;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docs/generated/driver-capabilities.json")
    });
    let json = serde_json::to_string_pretty(&all_driver_capabilities())? + "\n";
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output, json)?;
    println!("wrote {}", output.display());
    Ok(())
}
