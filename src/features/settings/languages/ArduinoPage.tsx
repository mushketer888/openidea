import { useEffect, useId, useState } from "react";
import { call, commands, isCancelled, isTauri, nextRequestId, type ArduinoBoard } from "@/platform/ipc";
import { normalizeArduinoSketchFolder } from "@/platform/languageSettings";
import { IconButton, Input, Select, type SelectOption, T } from "@/ui";
import { useSetting } from "../components/context";
import { Row, Section } from "../components/Form";
import { choosePath } from "./api";
import styles from "./Sdk.module.css";

function ToolPath({ name, label, title }: { name: string; label: string; title: string }) {
  const [value, setValue] = useSetting<string>(`languages.arduino.${name}`);
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <span className={styles.pathRow}>
        <Input
          id={id}
          mono
          className={styles.pathInput}
          value={value}
          placeholder="Automatic"
          onChange={(event) => setValue(event.target.value)}
        />
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          onClick={async () => {
            const path = await choosePath({ directory: false, title, defaultPath: value || undefined });
            if (path) setValue(path);
          }}
        />
      </span>
    </Row>
  );
}

function BoardSelect({
  value,
  boards,
  onChange,
  emptyLabel,
  label,
}: {
  value: string;
  boards: ArduinoBoard[];
  onChange: (fqbn: string) => void;
  emptyLabel: string;
  label: string;
}) {
  const options: SelectOption[] = [
    { value: "", label: emptyLabel },
    ...boards.map((board) => ({ value: board.fqbn, label: board.name, detail: board.fqbn })),
  ];
  return (
    <Select
      value={value}
      options={options}
      onChange={onChange}
      searchable
      className={styles.sdkSelect}
      aria-label={label}
      renderValue={(option) => (option ? <T>{option.label}</T> : value)}
    />
  );
}

export function ArduinoPage() {
  const [fqbn, setFqbn] = useSetting<string>("languages.arduino.fqbn");
  const [sketchBoards, setSketchBoards] = useSetting<Record<string, string>>("languages.arduino.sketchBoards");
  const [boards, setBoards] = useState<ArduinoBoard[]>([]);
  const [loading, setLoading] = useState(isTauri);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [folder, setFolder] = useState("");
  const [board, setBoard] = useState("");
  const normalizedFolder = normalizeArduinoSketchFolder(folder);
  const duplicate = normalizedFolder !== null && Object.hasOwn(sketchBoards, normalizedFolder);

  useEffect(() => {
    if (!isTauri()) return;
    const request = nextRequestId();
    let live = true;
    call(commands.sdkArduinoBoards(null, request))
      .then((installed) => {
        if (live) setBoards(installed);
      })
      .catch((reason: unknown) => {
        if (live && !isCancelled(reason)) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      void commands.cancelRequest(request).catch(() => {});
    };
  }, [revision]);

  const updateSketch = (path: string, value: string) => {
    const next = { ...sketchBoards, [path]: value };
    if (!value) delete next[path];
    setSketchBoards(next);
  };

  return (
    <div className={styles.page}>
      <Section title="Arduino tools">
        <Row
          label="Tool discovery"
          hint="Leave paths empty to detect Arduino CLI, clangd and Arduino Language Server from PATH or Arduino IDE, and the Arduino CLI configuration automatically. Explicit paths override detection."
        >
          <T>Automatic</T>
        </Row>
        <ToolPath name="cli" label="Arduino CLI" title="Select Arduino CLI" />
        <ToolPath name="clangd" label="clangd" title="Select clangd" />
        <ToolPath name="languageServer" label="Arduino Language Server" title="Select Arduino Language Server" />
        <ToolPath name="cliConfig" label="Arduino CLI configuration" title="Select Arduino CLI Configuration" />
      </Section>
      <Section title="Arduino boards">
        <Row
          label="Project default board"
          hint="Used unless a sketch has a board override. Automatic reads default_fqbn or the default_profile board from sketch.yaml; no board is guessed."
        >
          <span className={styles.sdkField}>
            <BoardSelect
              value={fqbn}
              boards={boards}
              onChange={setFqbn}
              emptyLabel="Automatic (sketch.yaml)"
              label="Project default board"
            />
            <IconButton
              icon="refresh"
              size="small"
              title="Reload installed boards"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                setError(null);
                setRevision((current) => current + 1);
              }}
            />
          </span>
        </Row>
        {loading && (
          <div className={styles.status} role="status">
            <T>Loading installed Arduino boards…</T>
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        {!loading && !error && boards.length === 0 && (
          <div className={styles.status}>
            <T>
              No installed Arduino boards found. Install a board platform with Arduino IDE or Arduino CLI, then reload.
            </T>
          </div>
        )}
        <Row
          label="Sketch board overrides"
          stacked
          hint="Sketch folders are relative to the project, with / separators. Use . for the project root. Removing an override uses the project default, then sketch.yaml. Save tool or configuration changes before reloading the installed boards."
        >
          <div className={styles.tablePanel}>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>
                      <T>Sketch folder</T>
                    </th>
                    <th>
                      <T>Board</T>
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(sketchBoards).map(([path, value]) => (
                    <tr key={path}>
                      <td>
                        <span className={styles.path}>{path}</span>
                      </td>
                      <td>
                        <BoardSelect
                          value={value}
                          boards={boards}
                          onChange={(next) => updateSketch(path, next)}
                          emptyLabel="Use project default"
                          label="Sketch board"
                        />
                      </td>
                      <td>
                        <IconButton
                          icon="minus"
                          size="small"
                          title="Remove sketch board override"
                          onClick={() => updateSketch(path, "")}
                        />
                      </td>
                    </tr>
                  ))}
                  {Object.keys(sketchBoards).length === 0 && (
                    <tr>
                      <td colSpan={3} className={styles.empty}>
                        <T>No sketch board overrides</T>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className={styles.installBar}>
              <Input
                mono
                className={styles.installInput}
                value={folder}
                placeholder="Relative sketch folder (. for project root)"
                aria-label="Sketch folder"
                invalid={!!folder && (normalizedFolder === null || duplicate)}
                onChange={(event) => setFolder(event.target.value)}
              />
              <BoardSelect
                value={board}
                boards={boards}
                onChange={setBoard}
                emptyLabel="Select a board"
                label="New sketch board"
              />
              <IconButton
                icon="plus"
                size="small"
                title="Add sketch board override"
                disabled={normalizedFolder === null || duplicate || !board}
                onClick={() => {
                  if (normalizedFolder === null || duplicate || !board) return;
                  updateSketch(normalizedFolder, board);
                  setFolder("");
                  setBoard("");
                }}
              />
            </div>
          </div>
          {folder && normalizedFolder === null && (
            <div className={styles.error}>
              <T>Enter a project-relative sketch folder without .. segments.</T>
            </div>
          )}
          {duplicate && (
            <div className={styles.error}>
              <T>A board override already exists for this sketch.</T>
            </div>
          )}
        </Row>
      </Section>
    </div>
  );
}
