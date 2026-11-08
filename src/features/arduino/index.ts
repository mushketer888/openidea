import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, registerOverlay } from "@/workbench/contributions";
import { ArduinoOverlay } from "./ArduinoDialogs";
import {
  ARDUINO_CONTEXT,
  ARDUINO_PREPARING,
  ARDUINO_TRUSTED,
  clearOwnedMonitors,
  refreshArduinoContext,
  startBuildSketch,
  startSerialMonitor,
  startUploadSketch,
  useArduinoDialog,
} from "./model";

const WHEN_SKETCH = `projectOpen && ${ARDUINO_TRUSTED} && ${ARDUINO_CONTEXT} && !${ARDUINO_PREPARING}`;
const WHEN_MONITOR = `projectOpen && ${ARDUINO_TRUSTED} && !${ARDUINO_PREPARING}`;

export function activate(): () => void {
  void refreshArduinoContext();

  const disposers: Array<() => void> = [
    registerOverlay({
      id: "arduino.dialogs",
      component: ArduinoOverlay,
    }),
    registerActions([
      {
        id: "arduino.buildSketch",
        title: "Build Sketch",
        description: "Compiles the active or selected Arduino sketch in the integrated terminal",
        category: "Build",
        icon: "build-project",
        when: WHEN_SKETCH,
        keywords: ["arduino", "verify", "compile", "ino", "sketch"],
        run: ({ arg }) => startBuildSketch(arg),
      },
      {
        id: "arduino.uploadSketch",
        title: "Upload Sketch…",
        description: "Compiles and uploads an Arduino sketch to a selected device port",
        category: "Build",
        when: WHEN_SKETCH,
        keywords: ["arduino", "flash", "upload", "ino", "sketch", "port"],
        run: ({ arg }) => startUploadSketch(arg),
      },
      {
        id: "arduino.serialMonitor",
        title: "Serial Monitor…",
        description: "Opens the Arduino CLI serial monitor for a selected port and baud rate",
        category: "Build",
        icon: "terminal",
        when: WHEN_MONITOR,
        keywords: ["arduino", "serial", "monitor", "uart", "baud", "com"],
        run: ({ arg }) => startSerialMonitor(arg),
      },
    ]),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) {
        clearOwnedMonitors();
        useArduinoDialog.setState({ dialog: null });
        void refreshArduinoContext();
        return;
      }
      if (
        s.project?.trusted !== prev.project?.trusted ||
        s.settings?.languages?.arduino !== prev.settings?.languages?.arduino
      ) {
        void refreshArduinoContext();
      }
    }),
    onIdeEvent("projectTrustChanged", () => {
      void refreshArduinoContext();
    }),
    onIdeEvent("fsChanged", (event) => {
      if ([...event.created, ...event.removed].some((p) => p.toLowerCase().endsWith(".ino"))) {
        void refreshArduinoContext();
      }
    }),
  ];

  const unsubEditor = maybeEditorService()?.onActiveInputChange?.((input) => {
    if (input?.path?.toLowerCase().endsWith(".ino")) {
      setContext(ARDUINO_CONTEXT, true);
    }
  });
  if (unsubEditor) disposers.push(unsubEditor);

  return () => {
    disposers.reverse().forEach((d) => d());
    clearOwnedMonitors();
    useArduinoDialog.setState({ dialog: null });
    setContext(ARDUINO_TRUSTED, false);
    setContext(ARDUINO_CONTEXT, false);
    setContext(ARDUINO_PREPARING, false);
  };
}
