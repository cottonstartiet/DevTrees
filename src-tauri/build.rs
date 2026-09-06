use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files);
        } else if path.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            files.push((relative, path));
        }
    }
}

fn main() {
    tauri_build::build();

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let web_dir = manifest_dir.join("..").join("dist-web");
    println!("cargo:rerun-if-changed={}", web_dir.display());

    let mut files = Vec::new();
    collect_files(&web_dir, &web_dir, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let generated = if files.is_empty() {
        r#"pub static EMBEDDED_WEB_ASSETS: &[(&str, &[u8])] = &[
    ("index.html", b"<!doctype html><html><body><h1>DevTrees UI is not built.</h1><p>Run yarn build:web, then rebuild the host.</p></body></html>"),
];
"#
        .to_string()
    } else {
        let entries = files
            .iter()
            .map(|(name, path)| {
                format!(
                    "    ({name:?}, include_bytes!({path:?}) as &[u8]),",
                    name = name,
                    path = path.canonicalize().unwrap_or_else(|_| path.clone())
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("pub static EMBEDDED_WEB_ASSETS: &[(&str, &[u8])] = &[\n{entries}\n];\n")
    };

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("embedded_web_assets.rs"), generated).unwrap();
}
