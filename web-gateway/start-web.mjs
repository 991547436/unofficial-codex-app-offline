import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const internalRoot = path.resolve(webRoot, "..");
const packageRoot = path.resolve(internalRoot, "..");
const appRoot = path.join(internalRoot, "app");
const appAsarPath = path.join(appRoot, "resources", "app.asar");
const codexExePath = path.join(appRoot, process.platform === "win32" ? "ChatGPT.exe" : "ChatGPT");
const codexAppServerPath = path.join(
  appRoot,
  "resources",
  process.platform === "win32" ? "codex.exe" : "codex",
);
const serverPath = path.join(webRoot, "gateway", "dist", "server.js");
const bundleCacheDir = path.join(webRoot, "cache", "official-bundle");

/** 检测 PATH 上是否存在可用的 codex 命令（CLI 模式）。 */
function hasCliCodex() {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["codex"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || "3737";
const publicUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

function fail(message) {
  console.error(`[codex-web] ${message}`);
  process.exit(1);
}

function requireFile(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} was not found: ${filePath}`);
  }
}

function quoteShellArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/api/health", url);

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(healthUrl, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1_000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`gateway did not become healthy within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 500);
    };

    tick();
  });
}

requireFile(serverPath, "Codex web gateway");

// 确定 app-server 命令：用户显式设置 > 打包二进制 > CLI > 报错
const userCmd = process.env.CODEX_APP_SERVER_CMD || "";
const hasBundledBinary = existsSync(codexAppServerPath);
const useCli = !userCmd && !hasBundledBinary && hasCliCodex();

if (!userCmd) {
  if (hasBundledBinary) {
    // 传统模式：使用打包的 codex 二进制
    requireFile(appAsarPath, "Codex app.asar");
    requireFile(codexExePath, "Codex executable");
  } else if (hasCliCodex()) {
    // CLI 模式：使用 PATH 上的 codex 命令
    console.log("[codex-web] 检测到 codex CLI，使用 CLI 模式");
  } else {
    fail(
      "未找到 Codex 后端。请安装 Codex CLI（npm install -g @openai/codex），" +
      "或将 Codex Desktop 放置到 " + appRoot
    );
  }
}

if ((host === "0.0.0.0" || host === "::") && !process.env.CODEX_WEB_PASSWORD) {
  fail("CODEX_WEB_PASSWORD is required when HOST listens beyond localhost.");
}

const env = {
  ...process.env,
  HOST: host,
  PORT: port,
  CODEX_DESKTOP_APP_PATH:
    process.env.CODEX_DESKTOP_APP_PATH ||
    (existsSync(appRoot) ? appRoot : ""),
  CODEX_APP_SERVER_CMD:
    userCmd ||
    (useCli
      ? "codex app-server --listen stdio://"
      : `${quoteShellArg(codexAppServerPath)} app-server --listen stdio://`),
  CODEX_WEB_OFFICIAL_BUNDLE_DIR:
    process.env.CODEX_WEB_OFFICIAL_BUNDLE_DIR || bundleCacheDir,
  CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE:
    process.env.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE || "1",
};

console.log(`[codex-web] starting gateway at ${publicUrl}`);
const server = spawn(process.execPath, [serverPath], {
  cwd: webRoot,
  env,
  stdio: "inherit",
});

let opened = false;
waitForHealth(publicUrl)
  .then(() => {
    if (opened) return;
    opened = true;
    console.log(`[codex-web] opening ${publicUrl}`);
    openBrowser(publicUrl);
  })
  .catch((error) => {
    console.warn(`[codex-web] ${error.message}`);
  });

server.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
  });
}
