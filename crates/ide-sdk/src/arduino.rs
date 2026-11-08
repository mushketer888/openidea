//! Arduino Language Server launch context, CLI command preparation, and board/port discovery.
//! Discovery only reads files; subprocesses run exclusively in explicit SDK requests.

use crate::apply::setting_path;
use crate::exec::{search_path, which};
use ide_core::settings::{ArduinoSettings, Settings};
use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use ide_language::{LanguageServerConfig, arduino_sketch_root};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const SERVER: &str = "arduino-language-server";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoBoard {
    pub name: String,
    pub fqbn: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ArduinoCommandKind {
    Build,
    Upload,
    Monitor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoSketchTarget {
    pub sketch: IpcPath,
    pub relative: String,
    pub name: String,
    pub fqbn: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoProjectContext {
    pub project_root: IpcPath,
    pub cli: IpcPath,
    pub cli_config: Option<IpcPath>,
    pub active_sketch: Option<ArduinoSketchTarget>,
    pub sketches: Vec<ArduinoSketchTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoPort {
    pub address: String,
    pub label: String,
    pub protocol: String,
    pub protocol_label: String,
    pub boards: Vec<ArduinoBoard>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoCommandSpec {
    pub kind: ArduinoCommandKind,
    #[serde(default)]
    pub sketch: Option<PathBuf>,
    #[serde(default)]
    pub fqbn: Option<String>,
    #[serde(default)]
    pub port: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub baud: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoPreparedCommand {
    pub program: IpcPath,
    pub args: Vec<String>,
    pub cwd: IpcPath,
    pub sketch: Option<IpcPath>,
    pub sketch_name: Option<String>,
    pub fqbn: Option<String>,
    pub port: Option<String>,
    pub protocol: Option<String>,
    pub baud: Option<u32>,
}

fn user_home() -> Option<PathBuf> {
    if cfg!(windows) {
        ide_core::process::host_var_os("USERPROFILE").map(PathBuf::from).or_else(crate::home_dir)
    } else {
        crate::home_dir()
    }
}

fn ide_resource_dirs() -> Vec<PathBuf> {
    let mut installs = Vec::new();
    if cfg!(windows) {
        if let Some(local) = ide_core::process::host_var_os("LOCALAPPDATA") {
            installs.push(PathBuf::from(local).join("Programs/Arduino IDE"));
        }
        for var in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = ide_core::process::host_var_os(var) {
                installs.push(PathBuf::from(dir).join("Arduino IDE"));
            }
        }
        installs.into_iter().map(|p| p.join("resources/app/lib/backend/resources")).collect()
    } else if cfg!(target_os = "macos") {
        installs.push(PathBuf::from("/Applications/Arduino IDE.app"));
        if let Some(home) = user_home() {
            installs.push(home.join("Applications/Arduino IDE.app"));
        }
        installs.into_iter().map(|p| p.join("Contents/Resources/app/lib/backend/resources")).collect()
    } else {
        // Extracted distribution locations; AppImage mount paths are not persistent settings.
        vec![PathBuf::from("/opt/arduino-ide/resources/app/lib/backend/resources")]
    }
}

fn resolve_tool(root: &Path, configured: &str, name: &str) -> IdeResult<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = setting_path(root, configured).unwrap_or_default();
        if path.is_file() {
            return Ok(path);
        }
        // A bare command is a useful explicit setting too; paths never fall back silently.
        if Path::new(configured).components().count() == 1
            && let Some(path) = which(configured)
        {
            return Ok(path);
        }
        return Err(IdeError::unavailable(format!(
            "Arduino tool '{configured}' was not found. Set Languages & Frameworks > Arduino > {name} to an installed executable."
        )));
    }
    which(name)
        .or_else(|| ide_resource_dirs().into_iter().map(|p| p.join(crate::exe(name))).find(|p| p.is_file()))
        .ok_or_else(|| IdeError::unavailable(format!(
            "Arduino tool '{name}' was not found on PATH or in Arduino IDE. Install Arduino IDE 2 or set its executable in Languages & Frameworks > Arduino."
        )))
}

fn cli_config(root: &Path, configured: &str) -> IdeResult<Option<PathBuf>> {
    if let Some(path) = setting_path(root, configured) {
        if !path.is_file() {
            return Err(IdeError::unavailable(format!(
                "Arduino CLI configuration {} does not exist. Select an existing arduino-cli.yaml in Languages & Frameworks > Arduino.",
                path.display()
            )));
        }
        return Ok(Some(path));
    }
    Ok(user_home().map(|p| p.join(".arduinoIDE/arduino-cli.yaml")).filter(|p| p.is_file()))
}

fn sketch_key(raw: &str) -> Option<String> {
    let key = raw.trim().replace('\\', "/");
    if key.is_empty() || key.starts_with('/') || key.as_bytes().get(1) == Some(&b':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in key.split('/') {
        match part {
            ".." => return None,
            "" | "." => {}
            part => parts.push(part),
        }
    }
    Some(if parts.is_empty() { ".".into() } else { parts.join("/") })
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Sketch {
    default_fqbn: String,
    default_profile: String,
    profiles: BTreeMap<String, SketchProfile>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SketchProfile {
    fqbn: String,
}

fn yaml_board(text: &str) -> IdeResult<Option<String>> {
    let sketch: Sketch =
        serde_yaml::from_str(text).map_err(|e| IdeError::invalid(format!("Cannot read Arduino sketch.yaml: {e}")))?;
    let board = if !sketch.default_fqbn.trim().is_empty() {
        sketch.default_fqbn.as_str()
    } else {
        sketch.profiles.get(sketch.default_profile.trim()).map_or("", |p| p.fqbn.as_str())
    };
    Ok((!board.trim().is_empty()).then(|| board.trim().to_owned()))
}

/// Per-sketch override, project FQBN, then this sketch's Arduino CLI metadata.
pub fn board(root: &Path, sketch: &Path, settings: &ArduinoSettings) -> IdeResult<String> {
    let relative = sketch
        .strip_prefix(root)
        .ok()
        .and_then(|p| if p.as_os_str().is_empty() { Some(".".into()) } else { sketch_key(&p.to_string_lossy()) });
    let selected = relative
        .as_ref()
        .and_then(|key| {
            settings.sketch_boards.iter().find_map(|(raw, value)| {
                (sketch_key(raw).as_ref() == Some(key) && !value.trim().is_empty()).then_some(value.as_str())
            })
        })
        .unwrap_or(&settings.fqbn)
        .trim();
    if !selected.is_empty() {
        return Ok(selected.to_owned());
    }
    let yaml = sketch.join("sketch.yaml");
    match std::fs::read_to_string(&yaml) {
        Ok(text) => {
            if let Some(board) = yaml_board(&text)? {
                return Ok(board);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(IdeError::unavailable(format!("Cannot read {}: {e}", yaml.display()))),
    }
    Err(IdeError::invalid(format!(
        "No Arduino board is selected for {}. Choose an installed board in Languages & Frameworks > Arduino, set its per-sketch FQBN, or add default_fqbn/default_profile to sketch.yaml. No board is chosen automatically.",
        sketch.display()
    )))
}

fn argument<'a>(args: &'a [String], flag: &str) -> IdeResult<Option<&'a str>> {
    for (index, arg) in args.iter().enumerate() {
        let key = arg.trim_start_matches('-');
        let value = if key == flag {
            Some(args.get(index + 1).map(String::as_str).filter(|v| !v.starts_with('-')).unwrap_or(""))
        } else {
            key.strip_prefix(flag).and_then(|tail| tail.strip_prefix('='))
        };
        if let Some(value) = value {
            if value.trim().is_empty() {
                return Err(IdeError::invalid(format!("Arduino Language Server argument -{flag} requires a value.")));
            }
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn server_args(settings: &Settings) -> &[String] {
    settings.language_servers.get(SERVER).and_then(|s| s.args.as_deref()).unwrap_or_default()
}

fn effective_cli(root: &Path, sketch: Option<&Path>, settings: &Settings) -> IdeResult<(PathBuf, Option<PathBuf>)> {
    let args = server_args(settings);
    let base = sketch.unwrap_or(root);
    let cli = match argument(args, "cli")? {
        Some(explicit) => resolve_tool(base, explicit, "arduino-cli")?,
        None => resolve_tool(root, &settings.languages.arduino.cli, "arduino-cli")?,
    };
    let config = match argument(args, "cli-config")? {
        Some(explicit) => cli_config(base, explicit)?,
        None => cli_config(root, &settings.languages.arduino.cli_config)?,
    };
    Ok((cli, config))
}

fn effective_board(root: &Path, sketch: &Path, settings: &Settings) -> IdeResult<String> {
    if let Some(explicit) = argument(server_args(settings), "fqbn")? {
        return non_flag_value(explicit, "board FQBN");
    }
    board(root, sketch, &settings.languages.arduino)
}

fn non_flag_value(raw: &str, label: &str) -> IdeResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(IdeError::invalid(format!("Arduino {label} is required.")));
    }
    if trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err(IdeError::invalid(format!("Invalid Arduino {label} '{trimmed}'.")));
    }
    Ok(trimmed.to_owned())
}

fn sketch_name(root: &Path, sketch: &Path) -> String {
    sketch
        .file_name()
        .or_else(|| root.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "sketch".into())
}

fn sketch_target(root: &Path, sketch: &Path, settings: &Settings) -> ArduinoSketchTarget {
    let relative = sketch
        .strip_prefix(root)
        .ok()
        .and_then(|p| if p.as_os_str().is_empty() { Some(".".into()) } else { sketch_key(&p.to_string_lossy()) })
        .unwrap_or_else(|| ".".into());
    ArduinoSketchTarget {
        name: sketch_name(root, sketch),
        sketch: sketch.to_path_buf().into(),
        relative,
        fqbn: effective_board(root, sketch, settings).ok(),
    }
}

fn discover_sketches(root: &Path, cancel: &CancellationToken) -> IdeResult<BTreeSet<PathBuf>> {
    let mut found = BTreeSet::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !name.starts_with('.')
                && !matches!(name.as_ref(), "node_modules" | "target" | "dist" | "build" | "out" | "vendor")
        })
        .build();
    for entry in walker {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ino"))
            && let Some(parent) = entry.path().parent()
            && parent.starts_with(root)
        {
            found.insert(parent.to_path_buf());
        }
    }
    Ok(found)
}

/// Effective CLI, active sketch (if `near` points inside one) and all project sketches.
/// Does not require `clangd` or `arduino-language-server` to be installed.
pub fn project_context(
    root: &Path,
    near: Option<&Path>,
    settings: &Settings,
    cancel: &CancellationToken,
) -> IdeResult<ArduinoProjectContext> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let active_dir = near.and_then(|path| {
        let resolved = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
        arduino_sketch_root(root, &resolved)
    });
    let (cli, cli_config) = effective_cli(root, active_dir.as_deref(), settings)?;
    let mut dirs = discover_sketches(root, cancel)?;
    if let Some(active) = &active_dir {
        dirs.insert(active.clone());
    }
    let mut sketches: Vec<_> = dirs.iter().map(|dir| sketch_target(root, dir, settings)).collect();
    sketches.sort_by(|a, b| (a.relative != ".").cmp(&(b.relative != ".")).then_with(|| a.relative.cmp(&b.relative)));
    let active_sketch = active_dir.map(|dir| sketch_target(root, &dir, settings));
    Ok(ArduinoProjectContext {
        project_root: root.to_path_buf().into(),
        cli: cli.into(),
        cli_config: cli_config.map(Into::into),
        active_sketch,
        sketches,
    })
}

fn resolve_sketch_dir(root: &Path, raw: Option<&Path>) -> IdeResult<PathBuf> {
    let Some(raw) = raw.filter(|p| !p.as_os_str().is_empty()) else {
        return Err(IdeError::invalid("Select an Arduino sketch folder first."));
    };
    let candidate = if raw.is_absolute() { raw.to_path_buf() } else { root.join(raw) };
    let Some(sketch) = arduino_sketch_root(root, &candidate) else {
        return Err(IdeError::invalid(format!(
            "{} is not an Arduino sketch inside {}. A sketch folder must contain a .ino file.",
            candidate.display(),
            root.display()
        )));
    };
    Ok(sketch)
}

/// Prepares a safe `program + argv + cwd` launch specification for Terminal execution.
pub fn prepare_command(
    root: &Path,
    settings: &Settings,
    spec: &ArduinoCommandSpec,
) -> IdeResult<ArduinoPreparedCommand> {
    let sketch = match spec.kind {
        ArduinoCommandKind::Build | ArduinoCommandKind::Upload => {
            Some(resolve_sketch_dir(root, spec.sketch.as_deref())?)
        }
        ArduinoCommandKind::Monitor => spec
            .sketch
            .as_deref()
            .filter(|p| !p.as_os_str().is_empty())
            .and_then(|p| arduino_sketch_root(root, &if p.is_absolute() { p.to_path_buf() } else { root.join(p) })),
    };
    let (cli, cli_config) = effective_cli(root, sketch.as_deref(), settings)?;
    let mut args = Vec::new();
    if let Some(config) = cli_config {
        args.extend(["--config-file".into(), config.to_string_lossy().into_owned()]);
    }
    let protocol = match spec.protocol.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(proto) => Some(non_flag_value(proto, "port protocol")?),
        None => None,
    };
    match spec.kind {
        ArduinoCommandKind::Build => {
            let sketch = sketch.expect("checked above");
            let fqbn = match spec.fqbn.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(explicit) => non_flag_value(explicit, "board FQBN")?,
                None => effective_board(root, &sketch, settings)?,
            };
            let name = sketch_name(root, &sketch);
            args.extend(["compile".into(), "--fqbn".into(), fqbn.clone(), sketch.to_string_lossy().into_owned()]);
            Ok(ArduinoPreparedCommand {
                program: cli.into(),
                args,
                cwd: sketch.clone().into(),
                sketch: Some(sketch.into()),
                sketch_name: Some(name),
                fqbn: Some(fqbn),
                port: None,
                protocol: None,
                baud: None,
            })
        }
        ArduinoCommandKind::Upload => {
            let sketch = sketch.expect("checked above");
            let fqbn = match spec.fqbn.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(explicit) => non_flag_value(explicit, "board FQBN")?,
                None => effective_board(root, &sketch, settings)?,
            };
            let raw_port = spec.port.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| {
                IdeError::invalid("Select an upload port first. No serial port is chosen automatically.")
            })?;
            let port = non_flag_value(raw_port, "upload port")?;
            let name = sketch_name(root, &sketch);
            args.extend([
                "compile".into(),
                "--fqbn".into(),
                fqbn.clone(),
                "--upload".into(),
                "--port".into(),
                port.clone(),
            ]);
            if let Some(proto) = &protocol {
                args.extend(["--protocol".into(), proto.clone()]);
            }
            args.push(sketch.to_string_lossy().into_owned());
            Ok(ArduinoPreparedCommand {
                program: cli.into(),
                args,
                cwd: sketch.clone().into(),
                sketch: Some(sketch.into()),
                sketch_name: Some(name),
                fqbn: Some(fqbn),
                port: Some(port),
                protocol,
                baud: None,
            })
        }
        ArduinoCommandKind::Monitor => {
            let raw_port = spec.port.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| {
                IdeError::invalid("Select a serial port for Serial Monitor. No port is chosen automatically.")
            })?;
            let port = non_flag_value(raw_port, "serial port")?;
            let baud = spec
                .baud
                .filter(|&b| b > 0)
                .ok_or_else(|| IdeError::invalid("Select a positive baud rate for Serial Monitor."))?;
            let fqbn = match spec.fqbn.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(explicit) => Some(non_flag_value(explicit, "board FQBN")?),
                None => sketch.as_deref().and_then(|dir| effective_board(root, dir, settings).ok()),
            };
            args.extend(["monitor".into(), "--port".into(), port.clone()]);
            if let Some(proto) = &protocol {
                args.extend(["--protocol".into(), proto.clone()]);
            }
            if let Some(fqbn) = &fqbn {
                args.extend(["--fqbn".into(), fqbn.clone()]);
            }
            args.extend(["--config".into(), format!("baudrate={baud}"), "--quiet".into(), "--raw".into()]);
            let cwd = sketch.clone().unwrap_or_else(|| root.to_path_buf());
            let name = sketch.as_deref().map(|dir| sketch_name(root, dir));
            Ok(ArduinoPreparedCommand {
                program: cli.into(),
                args,
                cwd: cwd.into(),
                sketch: sketch.map(Into::into),
                sketch_name: name,
                fqbn,
                port: Some(port),
                protocol,
                baud: Some(baud),
            })
        }
    }
}

fn configure_inner(cfg: &mut LanguageServerConfig, root: &Path, sketch: &Path, settings: &Settings) -> IdeResult<()> {
    let arduino = &settings.languages.arduino;
    let explicit_server = settings.language_servers.get(SERVER).is_some_and(|s| !s.command.trim().is_empty());
    if !explicit_server && cfg.command == SERVER {
        cfg.command = resolve_tool(root, &arduino.language_server, SERVER)?.to_string_lossy().into_owned();
    } else {
        // Keep generic command overrides, including wrappers and custom builds.
        cfg.command = resolve_tool(root, &cfg.command, SERVER)?.to_string_lossy().into_owned();
    }
    for (flag, configured, executable) in [("cli", &arduino.cli, "arduino-cli"), ("clangd", &arduino.clangd, "clangd")]
    {
        if let Some(value) = argument(&cfg.args, flag)? {
            resolve_tool(sketch, value, executable)?;
        } else {
            let path = resolve_tool(root, configured, executable)?;
            cfg.args.extend([format!("-{flag}"), path.to_string_lossy().into_owned()]);
        }
    }
    if let Some(value) = argument(&cfg.args, "cli-config")? {
        cli_config(sketch, value)?;
    } else if let Some(path) = cli_config(root, &arduino.cli_config)? {
        cfg.args.extend(["-cli-config".into(), path.to_string_lossy().into_owned()]);
    }
    if argument(&cfg.args, "fqbn")?.is_none() {
        cfg.args.extend(["-fqbn".into(), board(root, sketch, arduino)?]);
    }
    Ok(())
}

/// No tool execution here: config hooks run synchronously on the language-server path.
pub fn configure(cfg: &mut LanguageServerConfig, root: &Path, sketch: &Path, settings: &Settings) {
    if cfg.name != SERVER {
        return;
    }
    if let Err(error) = configure_inner(cfg, root, sketch, settings) {
        cfg.launch_error = Some(error.message);
    }
}

#[derive(Deserialize)]
struct CoreBoard {
    name: String,
    // Uninstalled platform releases list board names without an FQBN.
    #[serde(default)]
    fqbn: String,
}

#[derive(Deserialize)]
struct Core {
    #[serde(default)]
    boards: Vec<CoreBoard>,
    #[serde(default)]
    installed_version: String,
    #[serde(default)]
    releases: Option<BTreeMap<String, CoreRelease>>,
}

#[derive(Deserialize)]
struct CoreRelease {
    #[serde(default)]
    boards: Vec<CoreBoard>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CoreList {
    Wrapped { platforms: Vec<Core> },
    Legacy(Vec<Core>),
}

fn parse_boards(text: &str) -> IdeResult<Vec<ArduinoBoard>> {
    let list: CoreList = serde_json::from_str(text)
        .map_err(|e| IdeError::invalid(format!("Arduino CLI core list returned invalid JSON: {e}")))?;
    let cores = match list {
        CoreList::Wrapped { platforms } | CoreList::Legacy(platforms) => platforms,
    };
    let mut boards: Vec<_> = cores
        .into_iter()
        .flat_map(|core| match core.releases {
            Some(mut releases) => releases.remove(&core.installed_version).map_or_else(Vec::new, |r| r.boards),
            None => core.boards,
        })
        .filter(|b| !b.fqbn.trim().is_empty())
        .map(|board| ArduinoBoard { name: board.name, fqbn: board.fqbn })
        .collect();
    // Deduplicate before display sorting: aliases can give the same FQBN different names.
    boards.sort_by(|a, b| a.fqbn.cmp(&b.fqbn).then_with(|| a.name.cmp(&b.name)));
    boards.dedup_by(|a, b| a.fqbn == b.fqbn);
    boards.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.fqbn.cmp(&b.fqbn)));
    Ok(boards)
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawPortDetails {
    address: String,
    label: String,
    protocol: String,
    protocol_label: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawDetectedPort {
    port: Option<RawPortDetails>,
    address: String,
    label: String,
    protocol: String,
    protocol_label: String,
    matching_boards: Vec<CoreBoard>,
    boards: Vec<CoreBoard>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PortList {
    Wrapped {
        #[serde(default)]
        detected_ports: Vec<RawDetectedPort>,
    },
    Legacy(Vec<RawDetectedPort>),
}

fn parse_ports(text: &str) -> IdeResult<Vec<ArduinoPort>> {
    let list: PortList = serde_json::from_str(text)
        .map_err(|e| IdeError::invalid(format!("Arduino CLI board list returned invalid JSON: {e}")))?;
    let entries = match list {
        PortList::Wrapped { detected_ports } | PortList::Legacy(detected_ports) => detected_ports,
    };
    let mut ports: Vec<_> = entries
        .into_iter()
        .filter_map(|entry| {
            let details = entry.port.unwrap_or(RawPortDetails {
                address: entry.address,
                label: entry.label,
                protocol: entry.protocol,
                protocol_label: entry.protocol_label,
            });
            let address = details.address.trim().to_owned();
            if address.is_empty() {
                return None;
            }
            let label = if details.label.trim().is_empty() { address.clone() } else { details.label.trim().to_owned() };
            let protocol = details.protocol.trim().to_owned();
            let protocol_label = details.protocol_label.trim().to_owned();
            let mut boards: Vec<_> = entry
                .matching_boards
                .into_iter()
                .chain(entry.boards)
                .filter(|b| !b.fqbn.trim().is_empty())
                .map(|b| ArduinoBoard {
                    name: if b.name.trim().is_empty() { b.fqbn.trim().to_owned() } else { b.name.trim().to_owned() },
                    fqbn: b.fqbn.trim().to_owned(),
                })
                .collect();
            boards.sort_by(|a, b| a.fqbn.cmp(&b.fqbn).then_with(|| a.name.cmp(&b.name)));
            boards.dedup_by(|a, b| a.fqbn == b.fqbn);
            Some(ArduinoPort { address, label, protocol, protocol_label, boards })
        })
        .collect();
    ports.sort_by(|a, b| a.address.cmp(&b.address).then_with(|| a.protocol.cmp(&b.protocol)));
    ports.dedup_by(|a, b| a.address == b.address && a.protocol == b.protocol);
    Ok(ports)
}

/// Installed cores only: never queries attached hardware, downloads indexes or installs packages.
pub fn installed_boards(root: &Path, settings: &Settings, cancel: &CancellationToken) -> IdeResult<Vec<ArduinoBoard>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let (tool, config) = effective_cli(root, None, settings)?;
    let mut cmd = Command::new(&tool);
    cmd.args(["core", "list", "--format", "json"]);
    if let Some(config) = config {
        cmd.arg("--config-file").arg(config);
    }
    cmd.current_dir(root).env("PATH", search_path());
    let text = run_cli_json(cmd, "core list", cancel)?;
    parse_boards(&text)
}

/// Connected upload/serial ports reported by `arduino-cli board list` without opening a serial stream.
pub fn connected_ports(root: &Path, settings: &Settings, cancel: &CancellationToken) -> IdeResult<Vec<ArduinoPort>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let (tool, config) = effective_cli(root, None, settings)?;
    let mut cmd = Command::new(&tool);
    cmd.args(["board", "list", "--json"]);
    if let Some(config) = config {
        cmd.arg("--config-file").arg(config);
    }
    cmd.current_dir(root).env("PATH", search_path());
    let text = run_cli_json(cmd, "board list", cancel)?;
    parse_ports(&text)
}

fn run_cli_json(mut cmd: Command, operation: &str, cancel: &CancellationToken) -> IdeResult<String> {
    const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
    let deadline = Instant::now() + Duration::from_secs(20);
    ide_core::process::prepare(&mut cmd);
    ide_core::process::own_group(&mut cmd);
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| IdeError::unavailable(format!("Cannot run Arduino CLI {operation}: {e}")))?;
    let (tx, rx) = mpsc::sync_channel(16);
    for (is_out, pipe) in [
        (true, Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>),
        (false, Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>),
    ] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut buffer = [0; 4096];
            loop {
                let chunk = match pipe.read(&mut buffer) {
                    Ok(0) => None,
                    Ok(n) => Some(buffer[..n].to_vec()),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => None,
                };
                let done = chunk.is_none();
                if tx.send((is_out, chunk)).is_err() || done {
                    break;
                }
            }
        });
    }
    drop(tx);
    let (mut stdout, mut stderr, mut open, mut status) = (Vec::new(), Vec::new(), 2, None);
    let outcome = loop {
        if cancel.is_cancelled() {
            break Err(IdeError::cancelled());
        }
        if Instant::now() >= deadline {
            break Err(IdeError::unavailable(format!(
                "Arduino CLI {operation} timed out after 20 seconds. Check the selected CLI and its configuration.",
            )));
        }
        if stdout.len() + stderr.len() > OUTPUT_LIMIT {
            break Err(IdeError::unavailable(format!("Arduino CLI {operation} output exceeded 8 MiB.")));
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok((is_out, Some(chunk))) => if is_out { &mut stdout } else { &mut stderr }.extend(chunk),
            Ok((_, None)) => open -= 1,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                open = 0;
                if status.is_none() {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(result) => status = result,
                Err(e) => break Err(IdeError::unavailable(format!("Cannot wait for Arduino CLI: {e}"))),
            }
        }
        if open == 0
            && let Some(status) = status
        {
            if status.success() {
                break Ok(ide_core::output_encoding::decode_tool_output(&stdout));
            }
            break Err(IdeError::unavailable(format!(
                "Arduino CLI {operation} failed ({status}): {}",
                ide_core::output_encoding::decode_tool_output(&stderr).trim()
            )));
        }
    };
    if outcome.is_err() && status.is_none() {
        ide_core::process::kill_tree(&mut child);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_precedence_and_normalized_sketch_paths() {
        let dir = tempfile::tempdir().unwrap();
        let sketch = dir.path().join("examples/Blink");
        std::fs::create_dir_all(&sketch).unwrap();
        std::fs::write(sketch.join("sketch.yaml"), "default_fqbn: arduino:avr:mega\n").unwrap();
        let mut settings = ArduinoSettings::default();
        assert_eq!(board(dir.path(), &sketch, &settings).unwrap(), "arduino:avr:mega");
        settings.fqbn = " arduino:avr:uno ".into();
        assert_eq!(board(dir.path(), &sketch, &settings).unwrap(), "arduino:avr:uno");
        settings.sketch_boards.insert("./examples\\Blink/".into(), " arduino:avr:nano ".into());
        assert_eq!(board(dir.path(), &sketch, &settings).unwrap(), "arduino:avr:nano");
        assert_eq!(sketch_key("a//./b"), Some("a/b".into()));
        for key in ["", "../Blink", "/Blink", "C:/Blink"] {
            assert_eq!(sketch_key(key), None);
        }
    }

    #[test]
    fn yaml_supports_profiles_quotes_and_no_default_board() {
        assert_eq!(
            yaml_board("default_profile: 'uno'\nprofiles:\n  uno:\n    fqbn: \"arduino:avr:uno\" # board\n").unwrap(),
            Some("arduino:avr:uno".into())
        );
        assert_eq!(yaml_board("profiles:\n  uno:\n    fqbn: arduino:avr:uno\n").unwrap(), None);
        assert!(yaml_board("default_fqbn: [invalid\n").is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(
            board(dir.path(), dir.path(), &ArduinoSettings::default())
                .unwrap_err()
                .message
                .contains("No Arduino board")
        );
    }

    #[test]
    fn arguments_and_installed_core_formats() {
        let args = vec!["-fqbn=vendor:arch:board".into(), "--cli".into(), "custom-cli".into()];
        assert_eq!(argument(&args, "fqbn").unwrap(), Some("vendor:arch:board"));
        assert_eq!(argument(&args, "cli").unwrap(), Some("custom-cli"));
        assert_eq!(argument(&args, "cli-config").unwrap(), None);
        assert!(argument(&["-fqbn".into()], "fqbn").is_err());
        for text in [
            r#"[{"boards":[{"name":"Uno","fqbn":"arduino:avr:uno"}]}]"#,
            r#"{"platforms":[{"boards":[{"name":"Uno","fqbn":"arduino:avr:uno"}]}]}"#,
        ] {
            assert_eq!(
                parse_boards(text).unwrap(),
                vec![ArduinoBoard { name: "Uno".into(), fqbn: "arduino:avr:uno".into() }]
            );
        }
        assert!(parse_boards(r#"{"platforms":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn current_core_list_uses_only_the_installed_release_and_deduplicates_aliases() {
        let text = r#"{"platforms":[{
            "id":"arduino:avr",
            "installed_version":"1.8.7",
            "latest_version":"1.8.8",
            "releases":{
                "1.8.7":{"installed":true,"boards":[
                    {"name":"Arduino Uno","fqbn":"arduino:avr:uno"},
                    {"name":"Middle board","fqbn":"arduino:avr:nano"},
                    {"name":"Uno alias","fqbn":"arduino:avr:uno"}
                ]},
                "1.8.8":{"installed":false,"boards":[
                    {"name":"Available only"}
                ]}
            }
        },{
            "id":"vendor:available",
            "releases":{"1.0":{"boards":[{"name":"Not installed"}]}}
        }]}"#;
        assert_eq!(
            parse_boards(text).unwrap(),
            vec![
                ArduinoBoard { name: "Arduino Uno".into(), fqbn: "arduino:avr:uno".into() },
                ArduinoBoard { name: "Middle board".into(), fqbn: "arduino:avr:nano".into() },
            ]
        );
    }

    #[test]
    fn launch_preserves_explicit_tools_and_board_and_leaves_other_servers_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join(crate::exe("custom-tool"));
        std::fs::write(&executable, "").unwrap();
        let config = dir.path().join("custom.yaml");
        std::fs::write(&config, "directories: {}\n").unwrap();
        let tool = executable.to_string_lossy().into_owned();
        let mut cfg: LanguageServerConfig = serde_json::from_value(serde_json::json!({
            "name": SERVER, "command": tool,
            "args": ["-cli", tool, "-clangd", tool, "-cli-config", config.to_string_lossy(), "-fqbn=vendor:arch:board"]
        }))
        .unwrap();
        let args = cfg.args.clone();
        let mut settings = Settings::default();
        settings.languages.arduino.fqbn = "different:board:setting".into();
        settings.languages.arduino.cli = "missing-cli-should-not-win".into();
        configure(&mut cfg, dir.path(), dir.path(), &settings);
        assert_eq!(cfg.args, args);
        assert!(cfg.launch_error.is_none(), "{:?}", cfg.launch_error);
        cfg.name = "clangd".into();
        let unchanged = cfg.clone();
        configure(&mut cfg, dir.path(), dir.path(), &settings);
        assert_eq!(cfg, unchanged);
    }

    #[test]
    fn ports_parser_supports_wrapped_and_legacy_cli_json_and_deduplicates() {
        let wrapped = r#"{"detected_ports":[
            {
                "matching_boards":[
                    {"name":"Arduino Uno","fqbn":"arduino:avr:uno"},
                    {"name":"Uno duplicate","fqbn":"arduino:avr:uno"}
                ],
                "port":{"address":"COM4","label":"COM4","protocol":"serial","protocol_label":"Serial Port (USB)"}
            },
            {
                "matching_boards":[{"name":"No FQBN"}],
                "port":{"address":"COM3","protocol":"serial","protocol_label":"Serial Port"}
            },
            {
                "port":{"address":"COM4","protocol":"serial"}
            },
            {
                "port":{"address":"   "}
            }
        ]}"#;
        assert_eq!(
            parse_ports(wrapped).unwrap(),
            vec![
                ArduinoPort {
                    address: "COM3".into(),
                    label: "COM3".into(),
                    protocol: "serial".into(),
                    protocol_label: "Serial Port".into(),
                    boards: Vec::new(),
                },
                ArduinoPort {
                    address: "COM4".into(),
                    label: "COM4".into(),
                    protocol: "serial".into(),
                    protocol_label: "Serial Port (USB)".into(),
                    boards: vec![ArduinoBoard { name: "Arduino Uno".into(), fqbn: "arduino:avr:uno".into() }],
                },
            ]
        );
        let legacy =
            r#"[{"address":"/dev/ttyACM0","protocol":"serial","boards":[{"name":"Mega","fqbn":"arduino:avr:mega"}]}]"#;
        assert_eq!(parse_ports(legacy).unwrap()[0].boards[0].fqbn, "arduino:avr:mega");
    }

    #[test]
    fn prepare_command_preserves_argv_boundaries_and_rejects_unsafe_or_missing_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let cli_dir = root.join("tools with spaces");
        std::fs::create_dir_all(&cli_dir).unwrap();
        let cli = cli_dir.join(crate::exe("arduino-cli"));
        std::fs::write(&cli, "").unwrap();
        let cfg = cli_dir.join("arduino-cli.yaml");
        std::fs::write(&cfg, "directories: {}\n").unwrap();
        let sketch = root.join("скетч с пробелами");
        std::fs::create_dir_all(&sketch).unwrap();
        std::fs::write(sketch.join("скетч с пробелами.ino"), "void setup() {}\nvoid loop() {}\n").unwrap();

        let mut settings = Settings::default();
        settings.languages.arduino.cli = cli.to_string_lossy().into_owned();
        settings.languages.arduino.cli_config = cfg.to_string_lossy().into_owned();
        settings.languages.arduino.fqbn = "arduino:avr:uno".into();

        // Build works with CLI only (no clangd or language-server binary installed).
        let build = prepare_command(
            root,
            &settings,
            &ArduinoCommandSpec {
                kind: ArduinoCommandKind::Build,
                sketch: Some(sketch.clone()),
                fqbn: None,
                port: None,
                protocol: None,
                baud: None,
            },
        )
        .unwrap();
        assert_eq!(&*build.program, cli.as_path());
        assert_eq!(&*build.cwd, sketch.as_path());
        assert_eq!(
            build.args,
            vec![
                "--config-file",
                cfg.to_string_lossy().as_ref(),
                "compile",
                "--fqbn",
                "arduino:avr:uno",
                sketch.to_string_lossy().as_ref(),
            ]
        );

        // Upload requires an explicit non-flag port and uses single-invocation compile --upload.
        assert!(
            prepare_command(
                root,
                &settings,
                &ArduinoCommandSpec {
                    kind: ArduinoCommandKind::Upload,
                    sketch: Some(sketch.clone()),
                    fqbn: None,
                    port: None,
                    protocol: None,
                    baud: None,
                },
            )
            .is_err()
        );
        assert!(
            prepare_command(
                root,
                &settings,
                &ArduinoCommandSpec {
                    kind: ArduinoCommandKind::Upload,
                    sketch: Some(sketch.clone()),
                    fqbn: None,
                    port: Some("--upload-field=bad".into()),
                    protocol: None,
                    baud: None,
                },
            )
            .is_err()
        );
        let upload = prepare_command(
            root,
            &settings,
            &ArduinoCommandSpec {
                kind: ArduinoCommandKind::Upload,
                sketch: Some(sketch.clone()),
                fqbn: None,
                port: Some("COM7".into()),
                protocol: Some("serial".into()),
                baud: None,
            },
        )
        .unwrap();
        assert_eq!(
            upload.args,
            vec![
                "--config-file",
                cfg.to_string_lossy().as_ref(),
                "compile",
                "--fqbn",
                "arduino:avr:uno",
                "--upload",
                "--port",
                "COM7",
                "--protocol",
                "serial",
                sketch.to_string_lossy().as_ref(),
            ]
        );

        // Outside-project sketch paths are rejected.
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("out.ino"), "").unwrap();
        assert!(
            prepare_command(
                root,
                &settings,
                &ArduinoCommandSpec {
                    kind: ArduinoCommandKind::Build,
                    sketch: Some(outside.path().to_path_buf()),
                    fqbn: None,
                    port: None,
                    protocol: None,
                    baud: None,
                },
            )
            .is_err()
        );

        // Monitor works without a sketch or configured board when port and baud are given.
        settings.languages.arduino.fqbn.clear();
        let monitor = prepare_command(
            root,
            &settings,
            &ArduinoCommandSpec {
                kind: ArduinoCommandKind::Monitor,
                sketch: None,
                fqbn: None,
                port: Some("COM7".into()),
                protocol: Some("serial".into()),
                baud: Some(115_200),
            },
        )
        .unwrap();
        assert_eq!(&*monitor.cwd, root);
        assert_eq!(
            monitor.args,
            vec![
                "--config-file",
                cfg.to_string_lossy().as_ref(),
                "monitor",
                "--port",
                "COM7",
                "--protocol",
                "serial",
                "--config",
                "baudrate=115200",
                "--quiet",
                "--raw",
            ]
        );
    }

    #[test]
    fn project_context_discovers_sketches_and_selects_nearest_active_sketch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let cli = root.join(crate::exe("arduino-cli"));
        std::fs::write(&cli, "").unwrap();
        let first = root.join("sketches/alpha");
        let nested = root.join("sketches/alpha/examples/demo");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(first.join("alpha.ino"), "").unwrap();
        std::fs::write(nested.join("demo.ino"), "").unwrap();

        let mut settings = Settings::default();
        settings.languages.arduino.cli = cli.to_string_lossy().into_owned();
        settings.languages.arduino.fqbn = "arduino:avr:uno".into();
        settings
            .languages
            .arduino
            .sketch_boards
            .insert("sketches/alpha/examples/demo".into(), "arduino:avr:nano".into());

        let ctx =
            project_context(root, Some(&nested.join("helper.cpp")), &settings, &CancellationToken::new()).unwrap();
        assert_eq!(
            ctx.sketches.iter().map(|s| s.relative.as_str()).collect::<Vec<_>>(),
            ["sketches/alpha", "sketches/alpha/examples/demo",]
        );
        assert_eq!(ctx.active_sketch.as_ref().unwrap().relative, "sketches/alpha/examples/demo");
        assert_eq!(ctx.active_sketch.as_ref().unwrap().fqbn.as_deref(), Some("arduino:avr:nano"));
    }
}
