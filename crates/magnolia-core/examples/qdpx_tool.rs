//! Developer tool for comparing the Rust QDPX implementation against
//! fixtures: `read <in.qdpx>` prints the loaded project JSON;
//! `write <in.json> <out.qdpx> [carry.qdpx]` writes `{project, sourceContents}`.

use magnolia_core::qdpx::{reader, writer};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("read") => {
            let v = reader::read_qdpx(Path::new(&args[2]), None).unwrap();
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
        }
        Some("write") => {
            let input: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
            let mut project = input["project"].clone();
            let contents = input["sourceContents"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let carry = args.get(4).map(Path::new);
            let opts = writer::WriteOptions {
                app_version: "0.0.0-test",
                editor_name: "",
                carry_forward_from: carry,
                ..Default::default()
            };
            writer::write_qdpx(Path::new(&args[3]), &mut project, &contents, &opts).unwrap();
        }
        _ => eprintln!("usage: qdpx_tool read <in.qdpx> | write <in.json> <out.qdpx>"),
    }
}
