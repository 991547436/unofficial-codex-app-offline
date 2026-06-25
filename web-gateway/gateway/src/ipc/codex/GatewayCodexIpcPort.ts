// @ts-nocheck
export {};

const path = require("path");
const os = require("os");
const { UNHANDLED_CODEX_CHANNEL } = require("./IGatewayCodexIpcPort");
const {
  STATSIG_DEFAULT_FEATURE_OVERRIDES,
  STATSIG_DEFAULT_FEATURES_CONFIG,
  filterUnsupportedFeatureEnablements,
  isPlainObject,
  patchCodexConfigResult,
  patchConfigRequirementsResult,
  patchStatsigDefaultFeatureSnapshot,
  patchStatsigDefaultFeatures,
} = require("./featurePatches");
const { DEFAULT_DESKTOP_FEATURE_STATE } = require("./capabilityContract");
const { createAutomationIpcHandlers } = require("./automations");
const { createTerminalIpcHandlers } = require("./terminal");
const { createWorkerIpcHandlers } = require("./worker");
const { createViewMessageHandlers } = require("./viewMessages");
const { createGitIpcHandlers } = require("./git");
const { createAppServerBridge } = require("./appServerBridge");
const { createChatgptBackendIpcHandlers } = require("./chatgptBackend");
const { createFetchIpcHandlers } = require("./fetchIpc");
const { createConversationIpcHandlers } = require("./conversation");
const { createSharedObjectIpcHandlers } = require("./sharedObjectIpc");
const { createFilePreviewIpcHandlers } = require("./filePreview");
const { createWorkspaceRuntime } = require("./workspaceRuntime");
const { createWorkspaceIpcHandlers } = require("./workspaceIpc");
const { createDesktopState } = require("./desktopState");
const { createLocalFileIpcHandlers } = require("./localFiles");
const { nativeDesktopAppByBundleId, nativeDesktopAppIcon } = require("./nativeApps");
const { createRecommendedSkillsIpcHandlers } = require("./recommendedSkills");
const { normalizeMcpCodexConfig } = require("./mcpConfig");
const { buildLocaleInfo, buildOsInfo, chroniclePermissionsStatus } = require("./environmentInfo");

const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const REPORTS_DIR = path.join(PROJECT_ROOT, "reports");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_WEB_PICKED_FILES_DIR = path.join(CODEX_HOME, ".tmp", "web-picked-files");
const DESKTOP_GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const DESKTOP_PROJECT_ROOTS_KEY = "electron-saved-workspace-roots";
const DESKTOP_WORKSPACE_LABELS_KEY = "electron-workspace-root-labels";
const DESKTOP_PERSISTED_ATOMS_KEY = "electron-persisted-atom-state";
const DESKTOP_ARCHIVED_THREADS_KEY = "archivedThreads";
const CONFIGURATION_RAW_DESKTOP_KEYS = new Set([
  "browserAgent",
  "customCliExecutable",
  "customCliExecutablePath",
  "followUpQueueMode",
  "localeOverride",
  "remoteControlConnectionsEnabled",
]);
const CODEX_ASSET_ROOTS = [
  CODEX_WEB_PICKED_FILES_DIR,
  path.join(CODEX_HOME, ".tmp", "plugins"),
  path.join(CODEX_HOME, ".tmp", "bundled-marketplaces"),
  path.join(os.homedir(), ".cache", "codex-runtimes"),
];
const DEBUG_LOGS = process.env.CODEX_WEB_DEBUG === "1" || process.env.CODEX_WEB_DEBUG === "true";

function payloadShape(payload) {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return `array(${payload.length})`;
  if (typeof payload === "object") return `object(${Object.keys(payload).length})`;
  return typeof payload;
}

// ===== Hover Card / Pinned Threads BEGIN: 持久�?key =====
// 官方首页 hover card �?pin 状态通过 pinned-thread-ids 读写，Web 侧在 gateway 里桥接这�?Electron IPC�?
const PINNED_THREAD_IDS_STATE_KEY = "pinned-thread-ids";
// ===== Hover Card / Pinned Threads END: 持久�?key =====

const WARNED_UNSUPPORTED_FEATURE_ENABLEMENTS = new Set();
const COMPOSER_PERMISSION_MODE_VISIBILITY_KEY = "composer-permission-mode-visibility";
const DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY = {
  "guardian-approvals": true,
  "full-access": true,
};
const APP_SERVER_METHOD_ALIASES = new Map([
  ["mcpServer/list", "mcpServerStatus/list"],
]);
const SHARED_OBJECT_SNAPSHOT = new Map([
  ["host_config", { id: "local", kind: "local" }],
]);
const GLOBAL_STATE = new Map([
  ["QUEUED_FOLLOW_UPS", {}],
  ["THREAD_WORKSPACE_ROOT_HINTS", {}],
  ["projectless-thread-ids", []],
  ["use-copilot-auth-if-available", false],
  ["mac-menu-bar-enabled", false],
  ["selected-remote-host-id", null],
  ["remote-projects", []],
  ["active-remote-project-id", null],
  ["copilot-default-model", null],
  ["project-order", []],
  ["notifications-turn-mode", "unfocused"],
  ["notifications-permissions-enabled", false],
  ["notifications-questions-enabled", false],
]);
const PERSISTED_STATE = {};
// settings/configuration 只作为当前进程内的热缓存；真实持久化统一写回本机 Codex Desktop 状态�?
const SETTINGS_STATE = {};
const DESKTOP_VIEW_NOOP_MESSAGE_TYPES = new Set([
  "app-shell-shortcut-state-changed",
  "avatar-overlay-open-state-request",
  "browser-sidebar-owner-sync",
  "browser-use-non-local-sites-allowed-changed",
  "codex-runtimes-config-changed",
  "desktop-notification-hide",
  "electron-desktop-features-changed",
  "electron-app-state-snapshot-trigger",
  "electron-avatar-overlay-restore-ready",
  "electron-set-badge-count",
  "electron-set-window-mode",
  "electron-window-focus-request",
  "global-dictation-enabled-changed",
  "heartbeat-automation-thread-state-changed",
  "heartbeat-automations-enabled-changed",
  "hotkey-window-enabled-changed",
  "keyboard-layout-map-changed",
  "local-thread-activity-changed",
  "mac-menu-bar-enabled-changed",
  "power-save-blocker-set",
  "query-cache-invalidate",
  "ready",
  "set-telemetry-user",
  "shared-object-unsubscribe",
  "thread-stream-state-changed",
  "tray-menu-threads-changed",
  "view-focused",
]);

/** 只有 statsig initialize 需�?patch，其�?ChatGPT 后端请求不能误改�?*/
function shouldPatchStatsigInitialize(urlObject) {
  return (
    urlObject &&
    urlObject.hostname === "ab.chatgpt.com" &&
    urlObject.pathname.replace(/\/+$/, "") === "/v1/initialize"
  );
}

/** 生成注入�?web-shell 的运行时配置�?*/
function buildGatewayConfig() {
  const workspaceRoots = workspaceIpc.parseWorkspaceRoots();
  return {
    gatewayBaseUrl: "http://127.0.0.1:3737",
    workspaceRoots,
    homeDir: os.homedir(),
    appServer: process.env.CODEX_APP_SERVER_URL ? "remote" : "local",
    sharedObjectSnapshot: desktopState.sharedObjectSnapshotObject(),
    capabilities: {
      defaultDesktopFeatureState: DEFAULT_DESKTOP_FEATURE_STATE,
      statsigDefaultFeatureOverrides: STATSIG_DEFAULT_FEATURE_OVERRIDES,
      statsigDefaultFeaturesConfig: STATSIG_DEFAULT_FEATURES_CONFIG,
    },
  };
}

let workspaceIpc = null;
let workspaceRuntime = null;
const desktopState = createDesktopState({
  desktopGlobalStatePath: DESKTOP_GLOBAL_STATE_PATH,
  desktopProjectRootsKey: DESKTOP_PROJECT_ROOTS_KEY,
  desktopWorkspaceLabelsKey: DESKTOP_WORKSPACE_LABELS_KEY,
  desktopPersistedAtomsKey: DESKTOP_PERSISTED_ATOMS_KEY,
  desktopArchivedThreadsKey: DESKTOP_ARCHIVED_THREADS_KEY,
  configurationRawDesktopKeys: CONFIGURATION_RAW_DESKTOP_KEYS,
  pinnedThreadIdsStateKey: PINNED_THREAD_IDS_STATE_KEY,
  composerPermissionModeVisibilityKey: COMPOSER_PERMISSION_MODE_VISIBILITY_KEY,
  defaultComposerPermissionModeVisibility: DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY,
  statsigDefaultFeaturesConfig: STATSIG_DEFAULT_FEATURES_CONFIG,
  globalState: GLOBAL_STATE,
  persistedState: PERSISTED_STATE,
  settingsState: SETTINGS_STATE,
  sharedObjectSnapshot: SHARED_OBJECT_SNAPSHOT,
  isPlainObject,
  patchStatsigDefaultFeatureSnapshot,
  workspaceIpc: {
    listWorkspaceRoots: () => workspaceIpc.listWorkspaceRoots(),
    workspaceRootOptions: () => workspaceIpc.workspaceRootOptions(),
    activeWorkspaceRootPaths: () => workspaceIpc.activeWorkspaceRootPaths(),
  },
  workspaceRuntime: {
    listArchivedThreads: () => workspaceRuntime.listArchivedThreads(),
  },
});
desktopState.loadPersistentState();
workspaceRuntime = createWorkspaceRuntime({
  projectRoot: PROJECT_ROOT,
  settingsState: SETTINGS_STATE,
  desktopArchivedThreadsKey: DESKTOP_ARCHIVED_THREADS_KEY,
  globalState: GLOBAL_STATE,
  getDesktopGlobalStateValue: desktopState.getDesktopGlobalStateValue,
  setDesktopGlobalStateValue: desktopState.setDesktopGlobalStateValue,
  listWorkspaceRoots: () => workspaceIpc.listWorkspaceRoots(),
  activeWorkspaceRootPaths: () => workspaceIpc.activeWorkspaceRootPaths(),
  parseWorkspaceRoots: () => workspaceIpc.parseWorkspaceRoots(),
  realpathSafe: (filePath) => workspaceIpc.realpathSafe(filePath),
  isWithinAllowedRoots: (filePath) => workspaceIpc.isWithinAllowedRoots(filePath),
});
workspaceIpc = createWorkspaceIpcHandlers({
  projectRoot: PROJECT_ROOT,
  codexAssetRoots: CODEX_ASSET_ROOTS,
  desktopProjectRootsKey: DESKTOP_PROJECT_ROOTS_KEY,
  desktopWorkspaceLabelsKey: DESKTOP_WORKSPACE_LABELS_KEY,
  globalState: GLOBAL_STATE,
  getDesktopGlobalStateValue: desktopState.getDesktopGlobalStateValue,
  setDesktopGlobalStateValue: desktopState.setDesktopGlobalStateValue,
  getGlobalStateValue: desktopState.getGlobalStateValue,
  normalizeWorkspacePath: workspaceRuntime.normalizeWorkspacePath,
});
const localFiles = createLocalFileIpcHandlers({
  codexHome: CODEX_HOME,
  codexWebPickedFilesDir: CODEX_WEB_PICKED_FILES_DIR,
  reportsDir: REPORTS_DIR,
  projectRoot: PROJECT_ROOT,
  parseWorkspaceRoots: workspaceIpc.parseWorkspaceRoots,
  realpathSafe: workspaceIpc.realpathSafe,
  isWithinAllowedRoots: workspaceIpc.isWithinAllowedRoots,
});
const recommendedSkills = createRecommendedSkillsIpcHandlers({
  codexHome: CODEX_HOME,
  projectRoot: PROJECT_ROOT,
  activeWorkspaceRootPaths: workspaceIpc.activeWorkspaceRootPaths,
  parseWorkspaceRoots: workspaceIpc.parseWorkspaceRoots,
  realpathSafe: workspaceIpc.realpathSafe,
});

/**
 * 构�?Codex 业务 IPC handler 集合�?
 *
 * 这里是业务层核心：能本地处理的直接处理，需要真�?Codex 数据的转发给
 * app-server，需要浏览器响应的通过 broadcast �?web-shell�?
 */
function makeHandlers({ appServer, broadcast, logger, isClientConnected }) {
  const gitIpc = createGitIpcHandlers({
    realpathSafe: workspaceIpc.realpathSafe,
    isWithinAllowedRoots: workspaceIpc.isWithinAllowedRoots,
    parseWorkspaceRoots: workspaceIpc.parseWorkspaceRoots,
  });
  const workerIpc = createWorkerIpcHandlers({
    broadcast,
    logger,
    handleGitWorkerMethod: gitIpc.handleGitWorkerMethod,
  });
  const terminalIpc = createTerminalIpcHandlers({
    broadcast,
    logger,
    isClientConnected: typeof isClientConnected === "function" ? isClientConnected : () => false,
    resolveGatewayTerminalCwd: workspaceRuntime.resolveGatewayTerminalCwd,
    isWithinAllowedRoots: workspaceIpc.isWithinAllowedRoots,
    normalizeWorkspacePath: workspaceRuntime.normalizeWorkspacePath,
    shellQuote: workspaceRuntime.shellQuote,
  });

  const appServerBridge = createAppServerBridge({
    appServer,
    logger,
    appServerMethodAliases: APP_SERVER_METHOD_ALIASES,
    warnedUnsupportedFeatureEnablements: WARNED_UNSUPPORTED_FEATURE_ENABLEMENTS,
    filterUnsupportedFeatureEnablements,
    patchCodexConfigResult,
  });

  /** �?invoke context 中取浏览�?clientId�?*/
  function contextClientId(context) {
    return context && typeof context === "object" && typeof context.clientId === "string"
      ? context.clientId
      : "";
  }

  const automationIpc = createAutomationIpcHandlers({
    callAppServer: appServerBridge.callAppServer,
    permissionsForAppServer: workspaceRuntime.permissionsForAppServer,
    recordThreadWorkspaceRoot: workspaceRuntime.recordThreadWorkspaceRoot,
    normalizeWorkspacePath: workspaceRuntime.normalizeWorkspacePath,
    projectRoot: PROJECT_ROOT,
  });
  const chatgptBackend = createChatgptBackendIpcHandlers({
    callAppServer: appServerBridge.callAppServer,
    logger,
  });

  const fetchIpc = createFetchIpcHandlers({
    broadcast,
    logger,
    chatgptBackend,
    targetClientIdForContext,
    withTargetClient,
    invokeCodexChannel: (channel, payload, requestContext) => handle(channel, payload, requestContext),
    shouldPatchStatsigInitialize,
    patchStatsigDefaultFeatures,
    statsigDefaultFeatureOverrides: STATSIG_DEFAULT_FEATURE_OVERRIDES,
  });

  const viewMessages = createViewMessageHandlers({
    appServerBridge,
    avatarOverlayOpenStateKey: "electron-avatar-overlay-open",
    broadcast,
    contextClientId,
    debugLogs: DEBUG_LOGS,
    desktopState,
    desktopViewNoopMessageTypes: DESKTOP_VIEW_NOOP_MESSAGE_TYPES,
    fetchIpc,
    logger,
    patchCodexConfigResult,
    patchConfigRequirementsResult,
    payloadShape,
    persistedState: PERSISTED_STATE,
    runDetached,
    sharedObjectSnapshot: SHARED_OBJECT_SNAPSHOT,
    statsigDefaultFeaturesConfig: STATSIG_DEFAULT_FEATURES_CONFIG,
    targetClientIdForContext,
    terminalIpc,
    withTargetClient,
    workspaceIpc,
    workspaceRuntime,
  });

  const conversationIpc = createConversationIpcHandlers({
    appServerBridge,
    workspaceRuntime,
  });
  const sharedObjectIpc = createSharedObjectIpcHandlers({
    broadcast,
    desktopState,
    sharedObjectSnapshot: SHARED_OBJECT_SNAPSHOT,
    statsigDefaultFeaturesConfig: STATSIG_DEFAULT_FEATURES_CONFIG,
  });
  const filePreviewIpc = createFilePreviewIpcHandlers({
    appServerBridge,
    workspaceIpc,
  });

  /** fetch/mcp 响应默认回到发起请求的浏览器�?*/
  function targetClientIdForContext(context) {
    return contextClientId(context);
  }

  /** 给广播消息附�?targetClientId�?*/
  function withTargetClient(message, targetClientId) {
    return targetClientId ? { ...message, targetClientId } : message;
  }

  // ===== Hover Card / Pinned Threads BEGIN: 缓存刷新广播 =====
  // pinned 状态变化后需要主动失效官�?query cache，否�?hover card 的置顶状态不会立即刷新�?
  /** pinned threads 变更后通知官方 query 缓存失效，首�?hover/pin 状态会自然刷新�?*/
  function broadcastPinnedThreadsChanged(threadIds) {
    if (typeof broadcast !== "function") return;
    broadcast({
      channel: "query-cache-invalidate",
      payload: { type: "query-cache-invalidate", queryKey: ["list-pinned-threads"] },
    });
    broadcast({ channel: "pinned-threads-changed", payload: { threadIds } });
  }
  // ===== Hover Card / Pinned Threads END: 缓存刷新广播 =====

  function payloadParams(payload) {
    return payload && typeof payload === "object" && payload.params ? payload.params : payload;
  }

  function threadIdFromPayload(payload) {
    const params = payloadParams(payload);
    if (!params || typeof params !== "object") return null;
    return params.conversationId || params.threadId || params.id || null;
  }

  function hostIdFromPayload(payload) {
    const params = payloadParams(payload);
    return params && typeof params === "object" && typeof params.hostId === "string" ? params.hostId : "local";
  }

  function threadIdsFromPayload(payload) {
    const params = payloadParams(payload);
    const source = params && typeof params === "object" && Array.isArray(params.threadIds) ? params.threadIds : [];
    return source.filter((id) => typeof id === "string" && id);
  }

  function mergeArchivedThreads(primary, fallback) {
    const merged = [];
    const seen = new Set();
    for (const item of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])]) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return merged;
  }

  function broadcastArchivedThreadsChanged(hostId) {
    if (typeof broadcast !== "function") return;
    broadcast({
      channel: "query-cache-invalidate",
      payload: { type: "query-cache-invalidate", queryKey: ["archived-threads", hostId || "local"] },
    });
  }

  async function listAppServerArchivedThreads() {
    const threads = [];
    let cursor = null;
    let pageIndex = 0;
    do {
      try {
        const result = await appServerBridge.callAppServer("thread/list", {
          archived: true,
          cursor,
          limit: 200,
          modelProviders: null,
          sortKey: "updated_at",
        });
        if (Array.isArray(result && result.data)) threads.push(...result.data);
        cursor = result && result.nextCursor != null ? result.nextCursor : null;
        pageIndex++;
      } catch (error) {
        logger && logger.warn(`[ipc] app-server archived thread page ${pageIndex} failed; returning ${threads.length} partial results`, error);
        break;
      }
    } while (cursor);
    return threads;
  }

  async function listArchivedThreadsForPayload(payload) {
    const desktopThreads = workspaceRuntime.listArchivedThreads();
    // Return local state immediately; skip app-server fetch when offline
    if (appServer && typeof appServer.isConnected === "function" && appServer.isConnected()) {
      runDetached("sync-archived-threads", async () => {
        try {
          const appServerThreads = await listAppServerArchivedThreads();
          if (appServerThreads.length > 0) {
            const merged = mergeArchivedThreads(appServerThreads, desktopThreads);
            workspaceRuntime.setArchivedThreads(merged);
            broadcastArchivedThreadsChanged("local");
          }
        } catch (error) {
          logger && logger.warn("[ipc] background app-server archived thread fetch failed", error);
        }
      });
    }
    return desktopThreads;
  }

  async function archiveConversationForPayload(payload) {
    const conversationId = threadIdFromPayload(payload);
    const hostId = hostIdFromPayload(payload);
    if (!conversationId) return true;
    try {
      await appServerBridge.callAppServer("thread/archive", { threadId: conversationId });
    } catch (error) {
      logger && logger.warn("[ipc] app-server thread/archive failed; preserving desktop archived state", error);
    }
    const archived = workspaceRuntime.listArchivedThreads();
    if (!archived.some((item) => item && item.id === conversationId)) {
      const params = payloadParams(payload) || {};
      archived.unshift({
        id: conversationId,
        name: params.name || params.title || params.preview || null,
        preview: params.preview || null,
        cwd: params.cwd || null,
        path: params.path || null,
        hostId: params.hostId || null,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      });
      workspaceRuntime.setArchivedThreads(archived);
    }
    broadcastArchivedThreadsChanged(hostId);
    return true;
  }

  async function unarchiveConversationForPayload(payload) {
    const conversationId = threadIdFromPayload(payload);
    const hostId = hostIdFromPayload(payload);
    if (!conversationId) return true;
    try {
      await appServerBridge.callAppServer("thread/unarchive", { threadId: conversationId });
    } catch (error) {
      logger && logger.warn("[ipc] app-server thread/unarchive failed; clearing desktop archived state", error);
    }
    workspaceRuntime.setArchivedThreads(workspaceRuntime.listArchivedThreads().filter((item) => item && item.id !== conversationId));
    broadcastArchivedThreadsChanged(hostId);
    return true;
  }

  async function hydratePinnedThreadsForPayload(payload) {
    const threadIds = threadIdsFromPayload(payload);
    if (threadIds.length === 0) return { threadIds: [] };
    const archivedIds = new Set((await listArchivedThreadsForPayload(payload)).map((item) => item.id));
    const hydratedThreadIds = [];
    for (const threadId of threadIds) {
      if (archivedIds.has(threadId)) continue;
      try {
        await appServerBridge.callAppServer("thread/read", { threadId, includeTurns: false });
        hydratedThreadIds.push(threadId);
      } catch (error) {
        logger && logger.warn(`[ipc] failed to hydrate pinned thread: ${threadId}`, error);
      }
    }
    return { threadIds: hydratedThreadIds };
  }

  function runDetached(label, task) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        logger && logger.warn(`[ipc] detached ${label} failed`, error);
      });
    return true;
  }

  async function callAutomationBackend(channel, payload, fallback) {
    try {
      return await appServerBridge.callAppServer(channel, payload);
    } catch (error) {
      logger && logger.warn(`[ipc] automation backend unavailable for ${channel}`, error);
      if (typeof fallback === "function") return fallback();
      throw automationIpc.backendRequiredError();
    }
  }

  /** Codex 业务 IPC 总分发。未�?channel 必须抛错，不能再静默返回 null�?*/
  const handle = async (channel, payload, context = {}) => {
    switch (channel) {
      case "app:getPlatform":
        return "web";
      case "app:getVersion":
        return "web-poc";
      case "app:getConfig":
        return buildGatewayConfig();
      case "codex-command-keymap-state":
        return { bindings: [] };
      case "workspace-root-options":
        return workspaceIpc.workspaceRootOptions();
      case "add-workspace-root-option": {
        const result = workspaceIpc.addWorkspaceRootOption(payload);
        if (typeof broadcast === "function") {
          broadcast({ channel: "workspace-root-options-updated", payload: {} });
          if (payload && typeof payload === "object" && payload.setActive) {
            broadcast({ channel: "active-workspace-roots-updated", payload: {} });
          }
        }
        return result;
      }
      case "paths-exist":
        return workspaceIpc.pathsExist(payload);
      case "workspace-directory-entries": {
        return workspaceIpc.listWorkspaceDirectoryEntries(payload);
      }
      case "get-global-state":
        if (DEBUG_LOGS && payload && typeof payload === "object") {
          console.log(`[gateway] get-global-state key=${String(payload.key || "")}`);
        }
        return { value: desktopState.getGlobalStateValue(payload && typeof payload === "object" ? payload.key : null) };
      case "set-global-state": {
        const key = payload && typeof payload === "object" ? String(payload.key || "") : "";
        const result = desktopState.setGlobalStateValue(payload);
        if (typeof broadcast === "function") {
          const normalized = key.toLowerCase();
          if (normalized.includes("remote-projects") || normalized.includes("workspace-root-options")) {
            broadcast({ channel: "workspace-root-options-updated", payload: { key } });
          }
          if (normalized.includes("active-workspace-roots")) {
            broadcast({ channel: "active-workspace-roots-updated", payload: { key } });
          }
        }
        return result;
      }
      // ===== Hover Card / Pinned Threads BEGIN: renderer IPC handler =====
      // 官方 renderer 在首�?hover card/pin 交互中调用这三路 IPC；gateway 本地完成读写并广播刷新�?
      case "list-pinned-threads":
        return { threadIds: desktopState.readPinnedThreadIds() };
      case "set-thread-pinned": {
        const result = desktopState.setThreadPinnedValue(payload);
        broadcastPinnedThreadsChanged(result.threadIds);
        return result;
      }
      case "set-pinned-threads-order": {
        const result = desktopState.setPinnedThreadsOrderValue(payload);
        broadcastPinnedThreadsChanged(result.threadIds);
        return result;
      }
      // ===== Hover Card / Pinned Threads END: renderer IPC handler =====
      case "extension-info":
        return {
          available: false,
          installed: false,
          extensions: [],
          web: true,
        };
      case "os-info":
        return buildOsInfo();
      case "get-copilot-api-proxy-info":
        return null;
      case "is-copilot-api-available":
        return {
          available: false,
          isLoading: false,
        };
      case "mcp-codex-config": {
        const config = await appServerBridge.readCodexConfig(payload);
        const rawConfig = config && typeof config === "object" && "config" in config ? config.config : config;
        return { config: normalizeMcpCodexConfig(rawConfig) };
      }
      case "read-config":
      case "read-config-for-host":
        return appServerBridge.readCodexConfig(payload);
      case "list-models-for-host":
        return appServerBridge.listModelsForHost(payload);
      case "worktree-shell-environment-config":
        return { shellEnvironment: null };
      case "get-config-requirements-for-host":
        return patchConfigRequirementsResult(await appServerBridge.callAppServer("configRequirements/read", undefined));
      case "codex-agents-md": {
        // Web 环境没有 Chronicle，直接读�?workspace roots 下的 AGENTS.md/CLAUDE.md
        const roots = workspaceIpc.parseWorkspaceRoots();
        const fs = require("fs");
        const path = require("path");
        let instructions = "";
        const candidateNames = ["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md"];
        for (const root of roots) {
          for (const name of candidateNames) {
            const filePath = path.join(root, name);
            try {
              if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, "utf-8");
                if (content.trim()) {
                  instructions = content.trim();
                  break;
                }
              }
            } catch {}
          }
          if (instructions) break;
        }
        return { instructions };
      }
      case "developer-instructions": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        const baseInstructions =
          params && typeof params === "object" && typeof params.baseInstructions === "string"
            ? params.baseInstructions
            : null;
        return { instructions: baseInstructions };
      }
      case "experimentalFeature/list":
      case "list-experimental-features": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        return appServerBridge.callAppServer("experimentalFeature/list", params || {});
      }
      case "chronicle-permissions":
        // Web环境没有 Electron Chronicle sidecar，返回稳定状态让官方设置页正常渲染�?
        return chroniclePermissionsStatus();
      case "pick-files":
        // 文件选择�?web-shell 调浏览器 picker，gateway 负责落盘并返回官�?renderer 需要的 fsPath�?
        return localFiles.pickFilesForWeb(payload);
      case "read-file-metadata":
        return localFiles.readFileMetadata(payload);
      case "read-file-binary":
        return localFiles.readFileBinary(payload);
      case "list-automations":
        // Web 只是控制面：优先请求 Desktop/App 后端；离线或旧后端时只读展示本机定义�?
        return callAutomationBackend(channel, payload, () => automationIpc.listAutomations());
      case "list-pending-automation-run-threads":
        return { threadIds: [] };
      case "load-recent-conversation-ids-for-host":
        // Web 目前不维�?automation run 历史，只给前端一个稳定空列表避免阻塞页面�?
        return [];
      case "automation-run-now":
      case "automation-create":
      case "automation-update":
      case "automation-delete":
      case "automation-run-archive":
        return callAutomationBackend(channel, payload);
      case "active-workspace-roots":
        return { roots: workspaceIpc.activeWorkspaceRootPaths() };
      case "local-environments":
        return { environments: [] };
      case "has-custom-cli-executable": {
        const executable =
          desktopState.getConfigurationValue({ key: "customCliExecutable" }) ||
          desktopState.getConfigurationValue({ key: "customCliExecutablePath" }) ||
          null;
        return { hasCustomCliExecutable: typeof executable === "string" && executable.trim().length > 0 };
      }
      case "open-in-targets":
        return { targets: [], targetInfos: [] };
      case "native-desktop-app-by-bundle-id":
        return nativeDesktopAppByBundleId(payload);
      case "native-desktop-app-icon":
        return nativeDesktopAppIcon(payload);
      case "open-file":
        return localFiles.openFileForPayload(payload, context);
      case "get-configuration":
        return { value: desktopState.getConfigurationValue(payload) };
      case "set-configuration":
        return desktopState.setConfigurationValue(payload);
      case "set-remote-control-connections-enabled":
        if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "enabled")) {
          desktopState.setConfigurationValue({
            key: "remoteControlConnectionsEnabled",
            value: !!payload.enabled,
          });
        }
        return true;
      case "git-origins":
        return { origins: [] };
      case "inbox-items":
        return { items: [] };
      case "ambient-suggestions":
        return {
          file: workspaceRuntime.buildEmptyAmbientSuggestionsFile(
            payload && typeof payload === "object" ? payload.projectRoot || "" : ""
          ),
        };
      case "ambient-suggestions-refresh":
        return true;
      case "ide-context":
        return workspaceRuntime.buildIdeContext(payload);
      case "projectless-workspace-root":
        return { workspaceRoot: workspaceRuntime.getProjectlessWorkspaceRoot() };
      case "projectless-thread-cwd":
        return workspaceRuntime.resolveProjectlessThreadContext();
      case "email-domain-mail-provider":
        return {
          provider: workspaceRuntime.guessMailProvider(payload && typeof payload === "object" ? payload.domain : null),
        };
      case "account-info": {
        return chatgptBackend.accountInfoFromCodexAccount(payload);
      }
      case "recommended-skills":
        return recommendedSkills.listRecommendedSkills(payload);
      case "install-recommended-skill": {
        const result = recommendedSkills.installRecommendedSkill(payload);
        try {
          await appServerBridge.callAppServer("skills/list", { cwds: workspaceIpc.activeWorkspaceRootPaths(), forceReload: true });
        } catch {}
        return result;
      }
      case "codex-home":
        return path.join(os.homedir(), ".codex");
      case "home-directory":
        return { homeDirectory: os.homedir() };
      case "claude-code-import-status":
      case "external-agent-import-status":
        return { importedSessionCount: 0, latestImportedAtMs: null };
      case "external-agent-import-detect":
        return { items: [], unsupportedProjects: [] };
      case "external-agent-import-import":
        return { projectRoots: [] };
      case "external-agent-imported-connectors":
        return { connectors: [] };
      case "locale-info":
        return buildLocaleInfo();
      case "projects:list":
        return workspaceIpc.listProjects();
      case "projects:browse":
        return workspaceIpc.browseProjects(payload);
      case "threads:list":
      case "thread:list":
        return appServerBridge.callAppServer("thread/list", payload);
      case "start-conversation":
        return conversationIpc.startConversation(payload);
      case "start-thread-for-host": {
        const result = await appServerBridge.callAppServer("thread/start", payload);
        // 这个入口直接暴露 thread/start，必须同样记录真�?thread �?Desktop 元数据�?
        workspaceRuntime.recordThreadStartMetadata(result, payload);
        return result;
      }
      case "set-thread-title": {
        const params = payload && typeof payload === "object" ? payload : {};
        const threadId = params.threadId || params.conversationId || params.id || null;
        const name = typeof params.title === "string" ? params.title : params.name;
        if (!threadId || typeof name !== "string") return true;
        return appServerBridge.callAppServer("thread/name/set", { threadId, name });
      }
      case "generate-thread-title": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        const prompt = params && typeof params === "object" && typeof params.prompt === "string" ? params.prompt : "";
        const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
        return { title };
      }
      case "fast-mode-rollout-metrics":
        return null;
      case "native-desktop-apps":
        return { apps: [] };
      case "terminal-shell-options":
        return { availableShells: process.platform === "win32" ? ["powershell", "commandPrompt"] : [] };
      case "settings:get":
        return desktopState.getSettingValue(payload, { readCodexConfig: appServerBridge.readCodexConfig });
      case "settings:set":
        return desktopState.setSettingValue(payload, { callAppServer: appServerBridge.callAppServer });
      case "list-archived-threads":
        return listArchivedThreadsForPayload(payload);
      case "archive-conversation":
        return archiveConversationForPayload(payload);
      case "unarchive-conversation":
        return unarchiveConversationForPayload(payload);
      case "hydrate-pinned-threads":
        return hydratePinnedThreadsForPayload(payload);
      case "worktree-delete":
        return true;
      case "window:setTitle":
        if (typeof context.setTitle === "function") context.setTitle(payload);
        if (typeof broadcast === "function") broadcast({ channel: "window:setTitle", payload });
        return true;
      case "shell:openExternal":
        if (typeof context.openExternal === "function") return context.openExternal(payload);
        return true;
      case "codex:initialize":
        return appServerBridge.callAppServer("initialize", payload);
      case "transcribe":
        return chatgptBackend.transcribeAudioViaChatgpt(payload);
      case "codex_desktop:message-from-view":
        return viewMessages.handleViewMessage(payload, context);
      case "codex_desktop:get-shared-object-snapshot":
        return sharedObjectIpc.getSnapshot();
      case "shared-object-set":
        return sharedObjectIpc.setSharedObject(payload);
      case "shared-object-subscribe":
        return sharedObjectIpc.subscribeSharedObject(payload);
      case "thread:start": {
        const result = await appServerBridge.callAppServer("thread/start", payload);
        // 兼容旧式 thread:start channel，保持和 start-conversation 一样的刷新后归属信息�?
        workspaceRuntime.recordThreadStartMetadata(result, payload);
        return result;
      }
      case "turn:start":
        return appServerBridge.callAppServer("turn/start", payload);
      case "turn:interrupt":
        return appServerBridge.callAppServer("turn/interrupt", payload);
      case "approval:respond":
        if (payload && typeof payload === "object" && (payload.response || payload.message || payload.id)) {
          return appServerBridge.respondToAppServerRequest(payload);
        }
        return appServerBridge.callAppServer("approval/respond", payload);
      case "file:readPreview":
        return filePreviewIpc.readPreview(payload);
      case "file:stat":
        return filePreviewIpc.stat(payload);
      case "git:status":
        if (payload == null || (payload && typeof payload === "object")) {
          const localStatus = gitIpc.gitStatusForPayload(payload || {});
          if (localStatus != null) return localStatus;
        }
        return appServerBridge.callAppServer("git/status", payload);
      case "gh-cli-status":
        return gitIpc.ghCliStatus();
      case "stable-metadata":
        return gitIpc.gitStableMetadataForPayload(payload || {});
      case "current-branch":
        return gitIpc.currentBranchForPayload(payload || {});
      case "recent-branches":
      case "search-branches": {
        const result = gitIpc.recentBranchesForPayload(payload || {});
        const query =
          payload && typeof payload === "object" && typeof payload.query === "string"
            ? payload.query.trim().toLowerCase()
            : "";
        if (!query) return result;
        return {
          ...result,
          branches: result.branches.filter((branch) => branch.toLowerCase().includes(query)),
        };
      }
      case "git-create-branch":
        return gitIpc.createGitBranchForPayload(payload || {});
      case "git-checkout-branch":
        return gitIpc.checkoutGitBranchForPayload(payload || {});
      case "base-branch":
        return gitIpc.baseBranchForPayload(payload || {});
      default:
        if (channel.startsWith("codex_desktop:worker:") && channel.endsWith(":from-view")) {
          const handled = workerIpc.handleWorkerMessage(channel, payload);
          // worker 通道也要把未支持能力暴露给前端，避免只留 gateway 日志�?
          if (!handled) throw new Error(`Unsupported Codex worker message: ${channel}`);
          return true;
        }
        return UNHANDLED_CODEX_CHANNEL;
    }
  };

  return {
    handle,
    broadcast,
  };
}

/** Codex 业务 IPC 端口实现，只负责业务 channel，不实现 Electron 通用 IPC 语义�?*/
class GatewayCodexIpcPort {
  handlers;

  /** 初始化业�?handler；是否支持某�?channel �?handler 自己�?switch 决定�?*/
  constructor({ appServer, broadcast, logger, isClientConnected }) {
    this.handlers = makeHandlers({ appServer, broadcast, logger, isClientConnected });
  }

  /** 执行具体 Codex 业务 IPC�?*/
  handleCodexRequest(channel, payload, context) {
    return this.handlers.handle(channel, payload, context);
  }
}

module.exports = {
  GatewayCodexIpcPort,
  buildGatewayConfig,
  makeHandlers,
};