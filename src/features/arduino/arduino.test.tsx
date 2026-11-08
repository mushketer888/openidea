import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, getAction, isActionEnabled } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import {
  provideEditorService,
  provideNotificationService,
  provideTerminalCommandService,
  type EditorService,
  type TerminalCommandOptions,
} from "@/workbench/contributions";
import { OverlayHost } from "@/workbench/OverlayHost";
import { activate } from "./index";

const ipc = vi.hoisted(() => ({
  sdkArduinoContext: vi.fn(),
  sdkArduinoPorts: vi.fn(),
  sdkArduinoPrepareCommand: vi.fn(),
  findFiles: vi.fn(async () => ({ status: "ok" as const, data: [] })),
  cancelRequest: vi.fn(async () => undefined),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<{ commands: Record<string, unknown> }>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      sdkArduinoContext: ipc.sdkArduinoContext,
      sdkArduinoPorts: ipc.sdkArduinoPorts,
      sdkArduinoPrepareCommand: ipc.sdkArduinoPrepareCommand,
      findFiles: ipc.findFiles,
      cancelRequest: ipc.cancelRequest,
    },
  };
});

describe("Arduino Build, Upload and Serial Monitor actions", () => {
  let dispose: () => void;
  let saveAll: EditorService["saveAll"];
  let activePath: string | null;
  let runCalls: Array<{
    options: TerminalCommandOptions;
    running: boolean;
    focused: number;
    stopped: number;
  }>;
  let notices: Array<{ title: string; actions?: Array<{ label: string; run: () => void }> }>;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    activePath = "/proj/heater_on/heater_on.ino";
    saveAll = vi.fn(async () => undefined);
    runCalls = [];
    notices = [];

    provideEditorService({
      activePath: () => activePath,
      openPaths: () => (activePath ? [activePath] : []),
      saveAll,
    } as unknown as EditorService);

    provideNotificationService({
      notify: (n) => notices.push({ title: n.title, actions: n.actions }),
    });

    provideTerminalCommandService({
      runCommand: async (options) => {
        const entry = { options, running: true, focused: 0, stopped: 0 };
        runCalls.push(entry);
        return {
          tabId: `tab-${runCalls.length}`,
          isRunning: () => entry.running,
          focus: () => {
            entry.focused++;
          },
          stopAndClose: async () => {
            entry.running = false;
            entry.stopped++;
            options.onExit?.(null);
          },
        };
      },
    });

    useProject.setState({
      project: { root: "/proj", name: "proj", isGit: false, trusted: true, settings: {} } as never,
      settings: { languages: { arduino: { fqbn: "arduino:avr:uno" } } } as never,
    });
    setContext("projectOpen", true);
    dispose = activate();
  });

  afterEach(() => {
    dispose();
    cleanup();
    provideTerminalCommandService(undefined);
    useProject.setState({ project: null, settings: null });
    setContext("projectOpen", false);
  });

  it("disables Build, Upload and Serial Monitor in Restricted Mode", () => {
    act(() => {
      useProject.setState({
        project: { root: "/proj", name: "proj", isGit: false, trusted: false, settings: {} } as never,
      });
    });
    expect(isActionEnabled(getAction("arduino.buildSketch")!)).toBe(false);
    expect(isActionEnabled(getAction("arduino.uploadSketch")!)).toBe(false);
    expect(isActionEnabled(getAction("arduino.serialMonitor")!)).toBe(false);
  });

  it("saves open files and runs Build Sketch with keepOpenOnExit in the sketch directory", async () => {
    ipc.sdkArduinoContext.mockResolvedValue({
      status: "ok",
      data: {
        projectRoot: "/proj",
        cli: "C:/Program Files/Arduino IDE/arduino-cli.exe",
        cliConfig: "C:/Users/me/.arduinoIDE/arduino-cli.yaml",
        activeSketch: {
          sketch: "/proj/heater_on",
          relative: "heater_on",
          name: "heater_on",
          fqbn: "arduino:avr:uno",
        },
        sketches: [
          {
            sketch: "/proj/heater_on",
            relative: "heater_on",
            name: "heater_on",
            fqbn: "arduino:avr:uno",
          },
        ],
      },
    });
    ipc.sdkArduinoPrepareCommand.mockResolvedValue({
      status: "ok",
      data: {
        program: "C:/Program Files/Arduino IDE/arduino-cli.exe",
        args: [
          "--config-file",
          "C:/Users/me/.arduinoIDE/arduino-cli.yaml",
          "compile",
          "--fqbn",
          "arduino:avr:uno",
          "/proj/heater_on",
        ],
        cwd: "/proj/heater_on",
        sketch: "/proj/heater_on",
        sketchName: "heater_on",
        fqbn: "arduino:avr:uno",
        port: null,
        protocol: null,
        baud: null,
      },
    });

    await executeAction("arduino.buildSketch");

    expect(saveAll).toHaveBeenCalled();
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.options).toMatchObject({
      program: "C:/Program Files/Arduino IDE/arduino-cli.exe",
      cwd: "/proj/heater_on",
      keepOpenOnExit: true,
      restartOnEnter: true,
      transient: true,
    });
  });

  it("never auto-selects an unremembered port for Upload, closes owned monitor before upload, and disables Enter-restart", async () => {
    render(<OverlayHost />);

    // 1. Start an owned Serial Monitor on COM7 first.
    ipc.sdkArduinoPrepareCommand.mockResolvedValueOnce({
      status: "ok",
      data: {
        program: "/bin/arduino-cli",
        args: ["monitor", "--port", "COM7", "--config", "baudrate=115200", "--quiet", "--raw"],
        cwd: "/proj/heater_on",
        sketch: "/proj/heater_on",
        sketchName: "heater_on",
        fqbn: "arduino:avr:uno",
        port: "COM7",
        protocol: "serial",
        baud: 115200,
      },
    });
    ipc.sdkArduinoContext.mockResolvedValue({
      status: "ok",
      data: {
        projectRoot: "/proj",
        cli: "/bin/arduino-cli",
        cliConfig: null,
        activeSketch: {
          sketch: "/proj/heater_on",
          relative: "heater_on",
          name: "heater_on",
          fqbn: "arduino:avr:uno",
        },
        sketches: [
          {
            sketch: "/proj/heater_on",
            relative: "heater_on",
            name: "heater_on",
            fqbn: "arduino:avr:uno",
          },
        ],
      },
    });
    ipc.sdkArduinoPorts.mockResolvedValue({
      status: "ok",
      data: [
        { address: "COM3", label: "COM3", protocol: "serial", protocolLabel: "Serial Port", boards: [] },
        {
          address: "COM7",
          label: "COM7",
          protocol: "serial",
          protocolLabel: "Serial Port (USB)",
          boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }],
        },
      ],
    });

    // First verify Upload does not auto-pick COM3 when nothing was remembered yet.
    await act(async () => {
      await executeAction("arduino.uploadSketch");
    });
    const uploadBtnInitial = await screen.findByRole("button", { name: "Upload" });
    expect(uploadBtnInitial).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Open Serial Monitor on COM7 at 115200 baud.
    await act(async () => {
      await executeAction("arduino.serialMonitor");
    });
    const openMonitorBtn = await screen.findByRole("button", { name: "Open Monitor" });
    expect(openMonitorBtn).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Port" }));
    fireEvent.click(await screen.findByRole("option", { name: /COM7/ }));
    fireEvent.click(screen.getByRole("button", { name: "Baud rate" }));
    fireEvent.click(await screen.findByRole("option", { name: "115200" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Monitor" }));
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.running).toBe(true);

    // Calling Serial Monitor again with the same port/baud focuses the existing tab instead of opening a second one.
    await act(async () => {
      await executeAction("arduino.serialMonitor");
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Open Monitor" }));
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.focused).toBe(1);

    // Now open Upload Sketch: remembered COM7 is pre-selected, notice warns about closing active monitor, and confirming closes our COM7 monitor first.
    ipc.sdkArduinoPrepareCommand.mockResolvedValueOnce({
      status: "ok",
      data: {
        program: "/bin/arduino-cli",
        args: [
          "compile",
          "--fqbn",
          "arduino:avr:uno",
          "--upload",
          "--port",
          "COM7",
          "--protocol",
          "serial",
          "/proj/heater_on",
        ],
        cwd: "/proj/heater_on",
        sketch: "/proj/heater_on",
        sketchName: "heater_on",
        fqbn: "arduino:avr:uno",
        port: "COM7",
        protocol: "serial",
        baud: null,
      },
    });
    await act(async () => {
      await executeAction("arduino.uploadSketch");
    });
    expect(await screen.findByText(/Active Serial Monitor on COM7 will be closed/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    });
    await waitFor(() => expect(runCalls).toHaveLength(2));
    expect(runCalls[0]!.stopped).toBe(1);
    expect(runCalls[1]!.options.restartOnEnter).toBe(false);
    expect(runCalls[1]!.options.keepOpenOnExit).toBe(true);

    // When Upload finishes with exit code 0, user is offered an action to reopen the monitor (not auto-opened).
    act(() => {
      runCalls[1]!.options.onExit?.(0);
    });
    expect(runCalls).toHaveLength(2);
    expect(notices.some((n) => n.title === "Serial Monitor paused for upload")).toBe(true);
  });
});
