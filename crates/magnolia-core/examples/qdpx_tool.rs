//! Developer tool for comparing the Rust QDPX implementation against
//! fixtures: `read <in.qdpx>` prints the loaded project JSON;
//! `write <in.json> <out.qdpx> [carry.qdpx]` writes `{project, sourceContents}`;
//! `put <archive.qdpx> <entry> <text>` adds or replaces one entry and
//! `get <archive.qdpx> <entry>` prints one (for tests that need a file
//! Magnolia wouldn't write itself).

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
        Some("put") => put(Path::new(&args[2]), &args[3], args[4].as_bytes()),
        Some("get") => {
            use std::io::{Read, Write};
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&args[2]).unwrap()).unwrap();
            let mut data = Vec::new();
            zip.by_name(&args[3]).unwrap().read_to_end(&mut data).unwrap();
            std::io::stdout().write_all(&data).unwrap();
        }
        _ => eprintln!(
            "usage: qdpx_tool read <in.qdpx> | write <in.json> <out.qdpx> | put|get <archive.qdpx> <entry> [text]"
        ),
    }
}

/// Rewrite `archive` with `entry` holding `bytes` (added, or replacing it).
fn put(archive: &Path, entry: &str, bytes: &[u8]) {
    use std::io::{Read, Write};
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).unwrap()).unwrap();
    let tmp = archive.with_extension("put-tmp");
    let mut out = zip::ZipWriter::new(std::fs::File::create(&tmp).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        if name == entry {
            continue;
        }
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        out.start_file(name, options).unwrap();
        out.write_all(&data).unwrap();
    }
    out.start_file(entry, options).unwrap();
    out.write_all(bytes).unwrap();
    out.finish().unwrap();
    std::fs::rename(&tmp, archive).unwrap();
}
