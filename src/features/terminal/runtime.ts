/** Everything that needs xterm.js; loaded on first use through `loader.ts`. */
export {
  activeSession,
  applySettingsToAll,
  applyThemeToAll,
  closeAll,
  closeTabAsync,
  newTab,
  syncTerminalProject,
  unbindTerminals,
  newTabAt,
  renameTab,
  requestCloseSession,
  selectTab,
  sessionForTerminalId,
  sessionFromElement,
  splitTab,
  startDirectory,
  unsplit,
  useTerminals,
} from "./store";
export { TerminalTabs, TerminalView } from "./TerminalView";
export { applyThemeToEmbedded, createEmbeddedTerminal } from "./embedded";
export { closeTerminalFind, openTerminalFind, useTerminalFind } from "./FindBar";
