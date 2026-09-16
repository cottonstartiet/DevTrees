fn main() {
    let remote = std::path::Path::new("../dist-remote");
    if !remote.exists() {
        std::fs::create_dir_all(remote).expect("create remote asset placeholder");
        std::fs::write(
            remote.join("index.html"),
            "<!doctype html><title>DevTrees Remote</title><p>Run yarn build:remote.</p>",
        )
        .expect("write remote asset placeholder");
    }
    tauri_build::build()
}
