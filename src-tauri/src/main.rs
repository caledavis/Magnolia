// Release builds on Windows are GUI-subsystem apps, so no console window opens
// beside Magnolia (closing it would quit the app). Debug builds keep it for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    magnolia_lib::run()
}
