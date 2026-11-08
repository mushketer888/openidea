//! Arduino sketches need their own board context, including their C/C++ sources.

use crate::LspManager;
use crate::server::Server;
use ide_core::{LanguageId, Location};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) const SERVER: &str = "arduino-language-server";

pub(crate) fn sketch_root(project: &Path, file: &Path) -> Option<PathBuf> {
    ide_language::arduino_sketch_root(project, file)
}

pub(crate) fn configure_capabilities(capabilities: &mut Value) {
    // Arduino's proxy cannot decode the boolean full form or handle clangd's refresh request.
    for section in ["textDocument", "workspace"] {
        if let Some(section) = capabilities[section].as_object_mut() {
            section.remove("semanticTokens");
        }
    }
}

impl LspManager {
    pub(crate) fn arduino_servers(&self, language: &LanguageId, path: &Path) -> Option<Vec<Arc<Server>>> {
        if !matches!(language.as_str(), "c" | "cpp") {
            return None;
        }
        let configs = self.language_servers(&LanguageId::new("arduino"));
        let cfg = configs.iter().find(|cfg| cfg.name == SERVER)?;
        let project = self.project_root_for(path);
        if sketch_root(&project, path).is_some() {
            let server = self.server_for(cfg, &LanguageId::new("arduino"), path);
            server.add_language(language);
            let mut servers = vec![server];
            servers.extend(
                self.language_servers(language)
                    .iter()
                    .filter(|cfg| cfg.name != "clangd" && cfg.name != SERVER)
                    .filter(|cfg| {
                        !cfg.require_root_marker
                            || crate::launch::marked_root(&project, path, &cfg.root_markers).is_some()
                    })
                    .map(|cfg| self.server_for(cfg, language, path)),
            );
            return Some(servers);
        }
        if !path.starts_with(&project)
            && let Some(server) = self.origin_server(&crate::uri::path_to_uri_string(path))
            && server.name == SERVER
        {
            return Some(vec![server]);
        }
        None
    }

    pub(crate) fn note_arduino_sources(&self, server: &Arc<Server>, locations: &[Location]) {
        if server.name != SERVER {
            return;
        }
        let mut origins = None;
        for location in locations {
            let path: &Path = &location.path;
            if location.uri.is_none() && !path.starts_with(self.project_root_for(path)) {
                origins
                    .get_or_insert_with(|| self.virtual_origins.lock())
                    .insert(crate::uri::path_to_uri_string(path), server.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_sketches_keep_separate_board_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let inner = root.join("examples/blink");
        std::fs::create_dir_all(inner.join("src")).unwrap();
        std::fs::write(root.join("main.ino"), "").unwrap();
        std::fs::write(inner.join("blink.ino"), "").unwrap();
        assert_eq!(sketch_root(root, &inner.join("blink.ino")), Some(inner.clone()));
        assert_eq!(sketch_root(root, &inner.join("src/helper.cpp")), Some(inner));
        assert_eq!(sketch_root(root, &root.join("helper.h")), Some(root.to_path_buf()));
        assert_eq!(sketch_root(&root.join("examples"), &root.join("other.cpp")), None);
    }

    #[test]
    fn ordinary_cpp_projects_and_ino_named_directories_are_not_sketches() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("not-a-file.ino")).unwrap();
        assert_eq!(sketch_root(dir.path(), &dir.path().join("main.cpp")), None);
    }

    #[tokio::test]
    async fn cpp_routing_is_scoped_to_sketches_and_respects_disabled_arduino() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sketch = root.join("examples/blink");
        std::fs::create_dir_all(&sketch).unwrap();
        std::fs::write(sketch.join("blink.ino"), "").unwrap();
        let registry = Arc::new(ide_language::LanguageRegistry::load(None).unwrap());
        let manager = LspManager::new(root.to_path_buf(), registry, Arc::new(|_: ide_core::IdeEvent| {}));
        let cpp = LanguageId::new("cpp");
        let sketch_servers = manager.servers_for(&cpp, &sketch.join("helper.cpp"));
        assert_eq!(sketch_servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), [SERVER]);
        assert_eq!(sketch_servers[0].root, sketch);
        assert!(sketch_servers[0].languages().contains(&LanguageId::new("arduino")));
        assert_eq!(manager.servers_for(&cpp, &root.join("main.cpp"))[0].name, "clangd");
        manager.set_servers_hook(Box::new(
            |language, defined| {
                if language.as_str() == "arduino" { Vec::new() } else { defined.to_vec() }
            },
        ));
        assert_eq!(manager.servers_for(&cpp, &sketch.join("helper.cpp"))[0].name, "clangd");
    }
}
