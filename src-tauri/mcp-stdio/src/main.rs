#[tokio::main]
async fn main() {
    if let Err(error) = tabler_lib::mcp::run_stdio_server().await {
        eprintln!("TableR MCP server stopped: {error}");
        std::process::exit(1);
    }
}
