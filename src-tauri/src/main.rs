// Release builds on Windows are GUI-subsystem apps, so no console window opens
// beside Magnolia (closing it would quit the app). Debug builds keep it for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by an AI app (Claude Desktop…) as Magnolia's connector: talk
    // to it over stdin and stdout, not as the app (see mcp.rs).
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        magnolia_lib::mcp::run_connector();
        return;
    }
    magnolia_lib::run()
}
