import { useEffect, useState } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  isCancelled,
  isTauri,
  nextRequestId,
  type ArduinoPort,
  type ArduinoProjectContext,
  type ArduinoSketchTarget,
} from "@/platform/ipc";
import { Dialog, IconButton, Select, T, type SelectOption } from "@/ui";
import {
  BAUD_RATES,
  buildUploadPreviewArgs,
  confirmAndRunUpload,
  executePreparedBuild,
  formatCommandPreview,
  getRunningMonitor,
  launchSerialMonitor,
  normalizePortKey,
  openArduinoSettings,
  readArduinoPrefs,
  useArduinoDialog,
} from "./model";
import styles from "./ArduinoDialog.module.css";

function closeDialog() {
  useArduinoDialog.setState({ dialog: null });
}

function sketchOptions(sketches: readonly ArduinoSketchTarget[]): SelectOption[] {
  return sketches.map((s) => ({
    value: s.sketch,
    label: s.relative === "." ? s.name : s.relative,
    detail: s.fqbn ?? undefined,
  }));
}

function portDetail(port: ArduinoPort): string | undefined {
  const names = port.boards.map((b) => b.name).join(", ");
  if (names && port.protocolLabel) return `${names} · ${port.protocolLabel}`;
  return names || port.protocolLabel || port.protocol || undefined;
}

function portOptions(ports: readonly ArduinoPort[]): SelectOption[] {
  return [
    { value: "", label: "Select port" },
    ...ports.map((p) => ({
      value: p.address,
      label: p.label || p.address,
      detail: portDetail(p),
    })),
  ];
}

function initialSelectedPort(ports: readonly ArduinoPort[], remembered: string): string {
  if (!remembered) return "";
  const match = ports.find((p) => normalizePortKey(p.address) === normalizePortKey(remembered));
  return match?.address ?? "";
}

function BoardControl({ fqbn }: { fqbn: string | null }) {
  return (
    <div className={styles.controlRow}>
      <div className={styles.valueBox} title={fqbn ?? undefined}>
        {fqbn ? (
          <span>{fqbn}</span>
        ) : (
          <span className={styles.missingValue}>
            <T>No board configured</T>
          </span>
        )}
      </div>
      <IconButton
        icon="settings"
        size="small"
        title="Open Arduino Settings"
        aria-label="Open Arduino Settings"
        onClick={() => {
          closeDialog();
          openArduinoSettings();
        }}
      />
    </div>
  );
}

function SelectBuildSketchDialog({
  projectRoot,
  near,
  context,
}: {
  projectRoot: string;
  near: string | null;
  context: ArduinoProjectContext;
}) {
  const [selectedPath, setSelectedPath] = useState(
    () => context.activeSketch?.sketch ?? context.sketches[0]?.sketch ?? "",
  );
  const selected = context.sketches.find((s) => s.sketch === selectedPath) ?? context.sketches[0] ?? null;

  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Select Sketch to Build"
      width={440}
      buttons={[
        {
          label: "Build",
          role: "default",
          disabled: !selected || !selected.fqbn,
          onClick: () => {
            if (!selected) return;
            closeDialog();
            void executePreparedBuild(near, selected, projectRoot);
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.grid}>
          <span className={styles.label}>
            <T>Sketch</T>
          </span>
          <Select
            value={selected?.sketch ?? ""}
            options={sketchOptions(context.sketches)}
            onChange={setSelectedPath}
            searchable={context.sketches.length > 5}
            className={styles.select}
            aria-label="Sketch"
          />

          <span className={styles.label}>
            <T>Board</T>
          </span>
          <BoardControl fqbn={selected?.fqbn ?? null} />
          {!selected?.fqbn && (
            <div className={styles.subtext}>
              <T>Choose a board in Arduino settings or sketch.yaml before building or uploading.</T>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function UploadSketchDialog({
  projectRoot,
  near,
  context,
}: {
  projectRoot: string;
  near: string | null;
  context: ArduinoProjectContext;
}) {
  const remembered = readArduinoPrefs(projectRoot);
  const [selectedSketchPath, setSelectedSketchPath] = useState(
    () => context.activeSketch?.sketch ?? context.sketches[0]?.sketch ?? "",
  );
  const [ports, setPorts] = useState<ArduinoPort[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [loadingPorts, setLoadingPorts] = useState(isTauri);
  const [portsError, setPortsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    const req = nextRequestId();
    let live = true;
    call(commands.sdkArduinoPorts(near, req))
      .then((next) => {
        if (!live) return;
        setPorts(next);
        setSelectedPort((prev) => initialSelectedPort(next, prev || remembered.port));
      })
      .catch((e: unknown) => {
        if (live && !isCancelled(e)) setPortsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoadingPorts(false);
      });
    return () => {
      live = false;
      void commands.cancelRequest(req).catch(() => {});
    };
  }, [near, reloadCount, remembered.port]);

  const sketch = context.sketches.find((s) => s.sketch === selectedSketchPath) ?? context.sketches[0] ?? null;
  const portObj = ports.find((p) => p.address === selectedPort) ?? null;
  const fqbn = sketch?.fqbn ?? null;
  const activeMonitor = selectedPort ? getRunningMonitor(selectedPort) : null;
  const canUpload = Boolean(sketch && fqbn && selectedPort && !loadingPorts && !submitting);

  const previewText =
    sketch && fqbn && selectedPort
      ? formatCommandPreview(
          context.cli,
          buildUploadPreviewArgs(context.cliConfig, sketch.sketch, fqbn, selectedPort, portObj?.protocol ?? ""),
        )
      : null;

  const reloadPorts = () => {
    setPortsError(null);
    setLoadingPorts(true);
    setReloadCount((n) => n + 1);
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!submitting) closeDialog();
      }}
      title="Upload Sketch"
      width={480}
      buttons={[
        {
          label: "Upload",
          role: "default",
          disabled: !canUpload,
          onClick: async () => {
            if (!sketch || !selectedPort || submitting) return;
            setSubmitting(true);
            const ok = await confirmAndRunUpload({
              projectRoot,
              near,
              sketch,
              port: selectedPort,
              protocol: portObj?.protocol ?? "",
            });
            setSubmitting(false);
            if (ok) closeDialog();
          },
        },
        { label: "Cancel", role: "cancel", disabled: submitting },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.grid}>
          <span className={styles.label}>
            <T>Sketch</T>
          </span>
          <Select
            value={sketch?.sketch ?? ""}
            options={sketchOptions(context.sketches)}
            onChange={setSelectedSketchPath}
            searchable={context.sketches.length > 5}
            className={styles.select}
            aria-label="Sketch"
          />

          <span className={styles.label}>
            <T>Board</T>
          </span>
          <BoardControl fqbn={fqbn} />
          {!fqbn && (
            <div className={styles.subtext}>
              <T>Choose a board in Arduino settings or sketch.yaml before building or uploading.</T>
            </div>
          )}

          <span className={styles.label}>
            <T>Port</T>
          </span>
          <div className={styles.controlRow}>
            <Select
              value={selectedPort}
              options={portOptions(ports)}
              onChange={setSelectedPort}
              searchable={ports.length > 5}
              className={styles.select}
              aria-label="Port"
              renderValue={(opt) => (opt && opt.value === "" ? <T>{opt.label}</T> : (opt?.label ?? selectedPort))}
            />
            <IconButton
              icon="refresh"
              size="small"
              title="Reload connected ports"
              aria-label="Reload connected ports"
              disabled={loadingPorts || submitting}
              onClick={reloadPorts}
            />
          </div>
          {loadingPorts && (
            <div className={styles.subtext}>
              <T>Loading connected ports…</T>
            </div>
          )}
          {!loadingPorts && portsError && <div className={styles.errorText}>{portsError}</div>}
          {!loadingPorts && !portsError && ports.length === 0 && (
            <div className={styles.subtext}>
              <T>No connected ports detected. Connect a board and reload ports.</T>
            </div>
          )}

          <span className={clsx(styles.label, styles.topLabel)}>
            <T>Command</T>
          </span>
          {previewText ? (
            <pre className={styles.commandBox}>{previewText}</pre>
          ) : (
            <div className={styles.placeholderBox}>
              <T>Select a sketch, configured board and port to preview the upload command.</T>
            </div>
          )}
        </div>

        {activeMonitor && (
          <div className={styles.notice}>
            {tx`Active Serial Monitor on ${activeMonitor.port} will be closed before uploading.`}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function SerialMonitorDialog({
  projectRoot,
  near,
  context,
}: {
  projectRoot: string;
  near: string | null;
  context: ArduinoProjectContext | null;
}) {
  const remembered = readArduinoPrefs(projectRoot);
  const [ports, setPorts] = useState<ArduinoPort[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [baud, setBaud] = useState<number>(remembered.baud);
  const [loadingPorts, setLoadingPorts] = useState(isTauri);
  const [portsError, setPortsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    const req = nextRequestId();
    let live = true;
    call(commands.sdkArduinoPorts(near, req))
      .then((next) => {
        if (!live) return;
        setPorts(next);
        setSelectedPort((prev) => initialSelectedPort(next, prev || remembered.port));
      })
      .catch((e: unknown) => {
        if (live && !isCancelled(e)) setPortsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoadingPorts(false);
      });
    return () => {
      live = false;
      void commands.cancelRequest(req).catch(() => {});
    };
  }, [near, reloadCount, remembered.port]);

  const portObj = ports.find((p) => p.address === selectedPort) ?? null;
  const activeMonitor = selectedPort ? getRunningMonitor(selectedPort) : null;
  const baudOptions: SelectOption[] = BAUD_RATES.map((rate) => ({ value: String(rate), label: String(rate) }));
  const canOpen = Boolean(selectedPort && baud > 0 && !loadingPorts && !submitting);

  const reloadPorts = () => {
    setPortsError(null);
    setLoadingPorts(true);
    setReloadCount((n) => n + 1);
  };

  const activeMonitorBaud = activeMonitor ? String(activeMonitor.baud) : "";

  return (
    <Dialog
      open
      onClose={() => {
        if (!submitting) closeDialog();
      }}
      title="Arduino Serial Monitor"
      width={440}
      buttons={[
        {
          label: "Open Monitor",
          role: "default",
          disabled: !canOpen,
          onClick: async () => {
            if (!selectedPort || submitting) return;
            setSubmitting(true);
            const matchedBoard = portObj?.boards[0]?.fqbn ?? context?.activeSketch?.fqbn ?? null;
            const ok = await launchSerialMonitor({
              projectRoot,
              near,
              sketch: context?.activeSketch?.sketch ?? null,
              fqbn: matchedBoard,
              port: selectedPort,
              protocol: portObj?.protocol ?? "",
              baud,
            });
            setSubmitting(false);
            if (ok) closeDialog();
          },
        },
        { label: "Cancel", role: "cancel", disabled: submitting },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.grid}>
          <span className={styles.label}>
            <T>Port</T>
          </span>
          <div className={styles.controlRow}>
            <Select
              value={selectedPort}
              options={portOptions(ports)}
              onChange={setSelectedPort}
              searchable={ports.length > 5}
              className={styles.select}
              aria-label="Port"
              renderValue={(opt) => (opt && opt.value === "" ? <T>{opt.label}</T> : (opt?.label ?? selectedPort))}
            />
            <IconButton
              icon="refresh"
              size="small"
              title="Reload connected ports"
              aria-label="Reload connected ports"
              disabled={loadingPorts || submitting}
              onClick={reloadPorts}
            />
          </div>
          {loadingPorts && (
            <div className={styles.subtext}>
              <T>Loading connected ports…</T>
            </div>
          )}
          {!loadingPorts && portsError && <div className={styles.errorText}>{portsError}</div>}
          {!loadingPorts && !portsError && ports.length === 0 && (
            <div className={styles.subtext}>
              <T>No connected ports detected. Connect a board and reload ports.</T>
            </div>
          )}

          <span className={styles.label}>
            <T>Baud rate</T>
          </span>
          <Select
            value={String(baud)}
            options={baudOptions}
            onChange={(val) => {
              const parsed = Number(val);
              if (Number.isInteger(parsed) && parsed > 0) setBaud(parsed);
            }}
            className={styles.select}
            aria-label="Baud rate"
          />
        </div>

        {activeMonitor && (
          <div className={styles.notice}>
            {activeMonitor.baud === baud
              ? tx`Serial Monitor is already running on ${activeMonitor.port} at ${activeMonitorBaud} baud. Confirming will focus its tab.`
              : tx`Serial Monitor is running on ${activeMonitor.port} at ${activeMonitorBaud} baud. Confirming will restart it with the selected baud rate.`}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function ArduinoOverlay() {
  const dialog = useArduinoDialog((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.mode) {
    case "selectBuildSketch":
      return <SelectBuildSketchDialog projectRoot={dialog.projectRoot} near={dialog.near} context={dialog.context} />;
    case "upload":
      return <UploadSketchDialog projectRoot={dialog.projectRoot} near={dialog.near} context={dialog.context} />;
    case "monitor":
      return <SerialMonitorDialog projectRoot={dialog.projectRoot} near={dialog.near} context={dialog.context} />;
  }
}
