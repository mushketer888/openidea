import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  isCancelled,
  isTauri,
  nextRequestId,
  type ArduinoPreparedCommand,
  type ArduinoProjectContext,
  type ArduinoSketchTarget,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  maybeEditorService,
  maybeTerminalCommandService,
  notifications,
  projectViewSelection,
  type TerminalCommandHandle,
} from "@/workbench/contributions";
import { ask, showError } from "@/workbench/messages";

export const ARDUINO_TRUSTED = "arduinoTrusted";
export const ARDUINO_CONTEXT = "arduinoContext";
export const ARDUINO_PREPARING = "arduinoPreparing";

export const BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000, 2000000,
] as const;

export const DEFAULT_BAUD_RATE = 9600;
const PREFS_PREFIX = "openidea.arduino.prefs.v1:";
const PORT_RELEASE_DELAY_MS = 250;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface StoredArduinoPrefs {
  port: string;
  protocol: string;
  baud: number;
}

export interface OwnedMonitor {
  projectRoot: string;
  port: string;
  protocol: string;
  baud: number;
  sketch: string | null;
  fqbn: string | null;
  handle: TerminalCommandHandle;
}

export interface PausedMonitor {
  projectRoot: string;
  port: string;
  protocol: string;
  baud: number;
  sketch: string | null;
  fqbn: string | null;
}

export type ArduinoDialogState =
  | null
  | {
      mode: "selectBuildSketch";
      projectRoot: string;
      near: string | null;
      context: ArduinoProjectContext;
    }
  | {
      mode: "upload";
      projectRoot: string;
      near: string | null;
      context: ArduinoProjectContext;
    }
  | {
      mode: "monitor";
      projectRoot: string;
      near: string | null;
      context: ArduinoProjectContext | null;
    };

export const useArduinoDialog = create<{ dialog: ArduinoDialogState }>(() => ({ dialog: null }));

const ownedMonitors = new Map<string, OwnedMonitor>();

export function normalizePortKey(port: string): string {
  const trimmed = port.trim();
  return /^com\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

export function readArduinoPrefs(projectRoot: string): StoredArduinoPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_PREFIX + projectRoot) ?? "null") as Record<
      string,
      unknown
    > | null;
    const port = typeof raw?.port === "string" ? raw.port.trim() : "";
    const protocol = typeof raw?.protocol === "string" ? raw.protocol.trim() : "";
    const baud =
      typeof raw?.baud === "number" && Number.isInteger(raw.baud) && raw.baud > 0 ? raw.baud : DEFAULT_BAUD_RATE;
    return { port, protocol, baud };
  } catch {
    return { port: "", protocol: "", baud: DEFAULT_BAUD_RATE };
  }
}

export function writeArduinoPrefs(projectRoot: string, patch: Partial<StoredArduinoPrefs>) {
  const prev = readArduinoPrefs(projectRoot);
  const next: StoredArduinoPrefs = {
    port: patch.port !== undefined ? patch.port.trim() : prev.port,
    protocol: patch.protocol !== undefined ? patch.protocol.trim() : prev.protocol,
    baud: patch.baud !== undefined && patch.baud > 0 ? patch.baud : prev.baud,
  };
  try {
    localStorage.setItem(PREFS_PREFIX + projectRoot, JSON.stringify(next));
  } catch {
    /* ignore storage quota errors */
  }
}

function quotePreviewToken(token: string): string {
  if (!token) return '""';
  return /[\s"]/u.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token;
}

/** Display-only command preview; actual execution always passes separate `program` and `args`. */
export function formatCommandPreview(program: string, args: readonly string[]): string {
  return [program, ...args].map(quotePreviewToken).join(" ");
}

export function buildUploadPreviewArgs(
  cliConfig: string | null,
  sketch: string,
  fqbn: string,
  port: string,
  protocol: string,
): string[] {
  const args: string[] = [];
  if (cliConfig) args.push("--config-file", cliConfig);
  args.push("compile", "--fqbn", fqbn, "--upload", "--port", port);
  if (protocol) args.push("--protocol", protocol);
  args.push(sketch);
  return args;
}

export function getRunningMonitor(port: string): OwnedMonitor | null {
  if (!port.trim()) return null;
  const key = normalizePortKey(port);
  const entry = ownedMonitors.get(key);
  if (!entry) return null;
  if (!entry.handle.isRunning()) {
    ownedMonitors.delete(key);
    return null;
  }
  return entry;
}

export function clearOwnedMonitors() {
  ownedMonitors.clear();
}

export async function releaseMonitorForUpload(port: string): Promise<PausedMonitor | null> {
  const running = getRunningMonitor(port);
  if (!running) return null;
  const key = normalizePortKey(port);
  ownedMonitors.delete(key);
  await running.handle.stopAndClose();
  await delay(PORT_RELEASE_DELAY_MS);
  return {
    projectRoot: running.projectRoot,
    port: running.port,
    protocol: running.protocol,
    baud: running.baud,
    sketch: running.sketch,
    fqbn: running.fqbn,
  };
}

export function probeTargetPath(arg?: unknown): string | null {
  if (typeof arg === "string" && arg.trim()) return arg;
  const active = maybeEditorService()?.activePath();
  if (active) return active;
  const selected = projectViewSelection();
  return selected.length === 1 ? selected[0]! : null;
}

export function openArduinoSettings() {
  void executeAction("file.settings", "languages.arduino");
}

async function showArduinoError(message: string) {
  const offerSettings = /Arduino|board|FQBN|sketch\.yaml|arduino-cli/i.test(message);
  if (!offerSettings) {
    await showError("Cannot prepare Arduino command", message);
    return;
  }
  const res = await ask({
    title: "Cannot prepare Arduino command",
    body: message,
    icon: "error",
    buttons: [{ id: "settings", label: "Open Arduino Settings", primary: true }],
  });
  if (res.button === "settings") openArduinoSettings();
}

async function saveOpenDocuments(): Promise<boolean> {
  try {
    await maybeEditorService()?.saveAll();
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await showError("Cannot save open files before Arduino build", message);
    return false;
  }
}

function setPreparing(preparing: boolean) {
  setContext(ARDUINO_PREPARING, preparing);
}

export async function executePreparedBuild(near: string | null, sketch: ArduinoSketchTarget, expectedRoot: string) {
  if (useProject.getState().project?.root !== expectedRoot) return;
  if (!(await saveOpenDocuments())) return;
  const req = nextRequestId();
  setPreparing(true);
  try {
    const prepared = await call(
      commands.sdkArduinoPrepareCommand(
        near,
        { kind: "build", sketch: sketch.sketch, fqbn: null, port: null, protocol: null, baud: null },
        req,
      ),
    );
    if (useProject.getState().project?.root !== expectedRoot) return;
    const label = prepared.sketchName ?? sketch.name;
    await maybeTerminalCommandService()?.runCommand({
      program: prepared.program,
      args: prepared.args,
      cwd: prepared.cwd,
      name: tx`Arduino Build — ${label}`,
      keepOpenOnExit: true,
      restartOnEnter: true,
      transient: true,
    });
  } catch (e) {
    if (!isCancelled(e)) await showArduinoError(e instanceof Error ? e.message : String(e));
  } finally {
    setPreparing(false);
  }
}

export async function startBuildSketch(arg?: unknown): Promise<void> {
  const project = useProject.getState().project;
  if (!project || !project.trusted) return;
  if (!(await saveOpenDocuments())) return;
  const near = probeTargetPath(arg);
  const req = nextRequestId();
  setPreparing(true);
  let context: ArduinoProjectContext;
  try {
    context = await call(commands.sdkArduinoContext(near, req));
  } catch (e) {
    setPreparing(false);
    if (!isCancelled(e)) await showArduinoError(e instanceof Error ? e.message : String(e));
    return;
  }
  setPreparing(false);
  if (useProject.getState().project?.root !== project.root) return;
  if (context.activeSketch) {
    await executePreparedBuild(near, context.activeSketch, project.root);
    return;
  }
  if (context.sketches.length === 0) {
    await showError("Cannot prepare Arduino command", tx("No Arduino sketches (.ino) were found in this project."));
    return;
  }
  if (context.sketches.length === 1) {
    await executePreparedBuild(near, context.sketches[0]!, project.root);
    return;
  }
  useArduinoDialog.setState({
    dialog: { mode: "selectBuildSketch", projectRoot: project.root, near, context },
  });
}

export async function startUploadSketch(arg?: unknown): Promise<void> {
  const project = useProject.getState().project;
  if (!project || !project.trusted) return;
  if (!(await saveOpenDocuments())) return;
  const near = probeTargetPath(arg);
  const ctxReq = nextRequestId();
  setPreparing(true);
  try {
    const context = await call(commands.sdkArduinoContext(near, ctxReq));
    if (context.sketches.length === 0) {
      await showError("Cannot prepare Arduino command", tx("No Arduino sketches (.ino) were found in this project."));
      return;
    }
    if (useProject.getState().project?.root !== project.root) return;
    useArduinoDialog.setState({
      dialog: { mode: "upload", projectRoot: project.root, near, context },
    });
  } catch (e) {
    if (!isCancelled(e)) await showArduinoError(e instanceof Error ? e.message : String(e));
  } finally {
    setPreparing(false);
  }
}

export async function confirmAndRunUpload(opts: {
  projectRoot: string;
  near: string | null;
  sketch: ArduinoSketchTarget;
  port: string;
  protocol: string;
}): Promise<boolean> {
  if (useProject.getState().project?.root !== opts.projectRoot) return false;
  if (!(await saveOpenDocuments())) return false;
  const req = nextRequestId();
  setPreparing(true);
  let prepared: ArduinoPreparedCommand;
  try {
    prepared = await call(
      commands.sdkArduinoPrepareCommand(
        opts.near,
        {
          kind: "upload",
          sketch: opts.sketch.sketch,
          fqbn: null,
          port: opts.port,
          protocol: opts.protocol || null,
          baud: null,
        },
        req,
      ),
    );
  } catch (e) {
    setPreparing(false);
    if (!isCancelled(e)) await showArduinoError(e instanceof Error ? e.message : String(e));
    return false;
  }
  setPreparing(false);
  if (useProject.getState().project?.root !== opts.projectRoot) return false;

  const actualPort = prepared.port ?? opts.port;
  const actualProtocol = prepared.protocol ?? opts.protocol;
  writeArduinoPrefs(opts.projectRoot, { port: actualPort, protocol: actualProtocol });

  const paused = await releaseMonitorForUpload(actualPort);
  const label = prepared.sketchName ?? opts.sketch.name;
  await maybeTerminalCommandService()?.runCommand({
    program: prepared.program,
    args: prepared.args,
    cwd: prepared.cwd,
    name: tx`Arduino Upload — ${label}`,
    keepOpenOnExit: true,
    restartOnEnter: false,
    transient: true,
    onExit: (code) => {
      if (code === 0 && paused && useProject.getState().project?.root === paused.projectRoot) {
        offerMonitorResume(paused);
      }
    },
  });
  return true;
}

function offerMonitorResume(paused: PausedMonitor) {
  const baudText = String(paused.baud);
  notifications().notify({
    group: "run",
    level: "info",
    title: "Serial Monitor paused for upload",
    body: tx`Upload to ${paused.port} finished. Reopen Serial Monitor at ${baudText} baud?`,
    key: `arduino-monitor-resume:${normalizePortKey(paused.port)}`,
    actions: [
      {
        label: "Reopen Monitor",
        run: () => void resumeMonitorAfterUpload(paused),
      },
    ],
  });
}

async function resumeMonitorAfterUpload(paused: PausedMonitor) {
  if (useProject.getState().project?.root !== paused.projectRoot) return;
  try {
    const ports = await call(commands.sdkArduinoPorts(paused.sketch, nextRequestId()));
    const match = ports.find((p) => normalizePortKey(p.address) === normalizePortKey(paused.port));
    if (!match) {
      await startSerialMonitor(paused.sketch ?? undefined);
      return;
    }
    await launchSerialMonitor({
      projectRoot: paused.projectRoot,
      near: paused.sketch,
      sketch: paused.sketch,
      fqbn: paused.fqbn,
      port: match.address,
      protocol: match.protocol || paused.protocol,
      baud: paused.baud,
    });
  } catch {
    await startSerialMonitor(paused.sketch ?? undefined);
  }
}

export async function startSerialMonitor(arg?: unknown): Promise<void> {
  const project = useProject.getState().project;
  if (!project || !project.trusted) return;
  const near = probeTargetPath(arg);
  const ctxReq = nextRequestId();
  setPreparing(true);
  try {
    const context = await call(commands.sdkArduinoContext(near, ctxReq));
    if (useProject.getState().project?.root !== project.root) return;
    useArduinoDialog.setState({
      dialog: { mode: "monitor", projectRoot: project.root, near, context },
    });
  } catch (e) {
    if (!isCancelled(e)) await showArduinoError(e instanceof Error ? e.message : String(e));
  } finally {
    setPreparing(false);
  }
}

export async function launchSerialMonitor(opts: {
  projectRoot: string;
  near: string | null;
  sketch: string | null;
  fqbn: string | null;
  port: string;
  protocol: string;
  baud: number;
}): Promise<boolean> {
  if (useProject.getState().project?.root !== opts.projectRoot) return false;
  const existing = getRunningMonitor(opts.port);
  if (existing && existing.baud === opts.baud) {
    writeArduinoPrefs(opts.projectRoot, { port: opts.port, protocol: opts.protocol, baud: opts.baud });
    existing.handle.focus();
    return true;
  }
  const req = nextRequestId();
  setPreparing(true);
  let prepared: ArduinoPreparedCommand;
  try {
    prepared = await call(
      commands.sdkArduinoPrepareCommand(
        opts.near,
        {
          kind: "monitor",
          sketch: opts.sketch,
          fqbn: opts.fqbn,
          port: opts.port,
          protocol: opts.protocol || null,
          baud: opts.baud,
        },
        req,
      ),
    );
  } catch (e) {
    setPreparing(false);
    if (!isCancelled(e)) await showArduinoError(e instanceof Error ? e.message : String(e));
    return false;
  }
  setPreparing(false);
  if (useProject.getState().project?.root !== opts.projectRoot) return false;

  if (existing) {
    ownedMonitors.delete(normalizePortKey(opts.port));
    await existing.handle.stopAndClose();
    await delay(PORT_RELEASE_DELAY_MS);
  }

  const actualPort = prepared.port ?? opts.port;
  const actualProtocol = prepared.protocol ?? opts.protocol;
  const actualBaud = prepared.baud ?? opts.baud;
  writeArduinoPrefs(opts.projectRoot, { port: actualPort, protocol: actualProtocol, baud: actualBaud });
  const key = normalizePortKey(actualPort);
  const baudText = String(actualBaud);
  const handle = await maybeTerminalCommandService()?.runCommand({
    program: prepared.program,
    args: prepared.args,
    cwd: prepared.cwd,
    name: tx`Serial Monitor — ${actualPort} (${baudText} baud)`,
    keepOpenOnExit: true,
    restartOnEnter: true,
    transient: true,
    onExit: () => {
      const current = ownedMonitors.get(key);
      if (current?.handle === handle) ownedMonitors.delete(key);
    },
  });
  if (handle) {
    ownedMonitors.set(key, {
      projectRoot: opts.projectRoot,
      port: actualPort,
      protocol: actualProtocol,
      baud: actualBaud,
      sketch: prepared.sketch ?? opts.sketch,
      fqbn: prepared.fqbn ?? opts.fqbn,
      handle,
    });
  }
  return true;
}

export function hasArduinoSettingsConfigured(): boolean {
  const a = useProject.getState().settings?.languages?.arduino;
  if (!a) return false;
  return Boolean(
    a.fqbn?.trim() ||
    a.cli?.trim() ||
    a.clangd?.trim() ||
    a.languageServer?.trim() ||
    a.cliConfig?.trim() ||
    (a.sketchBoards && Object.keys(a.sketchBoards).length > 0),
  );
}

export function hasOpenInoDocument(): boolean {
  const editor = maybeEditorService();
  if (!editor) return false;
  const active = editor.activePath();
  if (active?.toLowerCase().endsWith(".ino")) return true;
  return editor.openPaths?.().some((p) => p.toLowerCase().endsWith(".ino")) ?? false;
}

let contextProbeGeneration = 0;

export async function refreshArduinoContext(): Promise<void> {
  const state = useProject.getState();
  const project = state.project;
  const trusted = project?.trusted === true;
  setContext(ARDUINO_TRUSTED, trusted);
  if (!project) {
    setContext(ARDUINO_CONTEXT, false);
    return;
  }
  if (hasOpenInoDocument() || hasArduinoSettingsConfigured()) {
    setContext(ARDUINO_CONTEXT, true);
    return;
  }
  if (!isTauri()) {
    setContext(ARDUINO_CONTEXT, false);
    return;
  }
  const gen = ++contextProbeGeneration;
  try {
    const matches = await call(commands.findFiles("ino", 50));
    if (gen !== contextProbeGeneration || useProject.getState().project?.root !== project.root) return;
    if (matches.some((m) => m.relPath.toLowerCase().endsWith(".ino"))) {
      setContext(ARDUINO_CONTEXT, true);
      return;
    }
    if (trusted) {
      const ctx = await call(commands.sdkArduinoContext(null, nextRequestId()));
      if (gen !== contextProbeGeneration || useProject.getState().project?.root !== project.root) return;
      setContext(ARDUINO_CONTEXT, ctx.sketches.length > 0);
      return;
    }
    setContext(ARDUINO_CONTEXT, false);
  } catch {
    if (gen === contextProbeGeneration) {
      setContext(ARDUINO_CONTEXT, hasOpenInoDocument() || hasArduinoSettingsConfigured());
    }
  }
}
