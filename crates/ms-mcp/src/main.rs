mod api;
mod tools;

use rmcp::{ServiceExt, transport::stdio};
use tools::MassSpectrometrist;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = MassSpectrometrist.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
