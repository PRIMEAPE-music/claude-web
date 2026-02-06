// browser-server.js - Shared Chrome Browser Manager
// Launches and manages a single Chrome instance with --remote-debugging-port
// that both claude-web and Claude's MCP server can connect to via CDP.

import { spawn, execSync } from "child_process";
import { EventEmitter } from "events";
import { mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import http from "http";

const CHROME_DATA_DIR = join(
  homedir(),
  ".claude",
  "claude-web",
  "shared-chrome",
);
const DEFAULT_PORT = 9222;
const HEALTH_CHECK_INTERVAL = 10000;
const MAX_RESTART_ATTEMPTS = 5;
const INITIAL_RESTART_DELAY = 2000;

class BrowserServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || DEFAULT_PORT;
    this.headless = options.headless ?? true;
    this.process = null;
    this.wsEndpoint = null;
    this.restartAttempts = 0;
    this.restartDelay = INITIAL_RESTART_DELAY;
    this._intentionalStop = false;
    this._healthCheckTimer = null;
    this._chromePath = null;
  }

  async start() {
    if (this.isRunning()) {
      console.log("[BrowserServer] Chrome already running");
      return;
    }

    // Check if something is already on the port
    const existing = await this._tryExistingChrome();
    if (existing) {
      console.log(`[BrowserServer] Found existing Chrome on port ${this.port}`);
      this.wsEndpoint = existing;
      this.emit("started", { wsEndpoint: this.wsEndpoint, adopted: true });
      this._startHealthCheck();
      return;
    }

    await mkdir(CHROME_DATA_DIR, { recursive: true });

    const chromePath = this._findChromePath();
    if (!chromePath) {
      throw new Error(
        "Chrome/Chromium not found. Install google-chrome-stable or chromium.",
      );
    }
    this._chromePath = chromePath;

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${CHROME_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--no-sandbox",
    ];

    if (this.headless) {
      args.push("--headless=new");
    }

    console.log(`[BrowserServer] Launching Chrome: ${chromePath}`);
    this._intentionalStop = false;

    this.process = spawn(chromePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.process.stdout.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[Chrome stdout] ${msg}`);
    });

    this.process.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        // Chrome logs DevTools URL to stderr
        const wsMatch = msg.match(/ws:\/\/[^\s]+/);
        if (wsMatch) {
          console.log(
            `[BrowserServer] Got WS endpoint from stderr: ${wsMatch[0]}`,
          );
        }
        if (msg.includes("ERROR") || msg.includes("FATAL")) {
          console.error(`[Chrome stderr] ${msg}`);
        }
      }
    });

    this.process.on("exit", (code, signal) => {
      console.log(
        `[BrowserServer] Chrome exited with code=${code} signal=${signal}`,
      );
      this._stopHealthCheck();
      this.process = null;

      if (!this._intentionalStop) {
        this.emit("crashed", { code, signal });
        this._scheduleRestart();
      }
    });

    this.process.on("error", (err) => {
      console.error(`[BrowserServer] Chrome process error:`, err.message);
      this.emit("error", err);
    });

    // Wait for Chrome to be ready
    const ready = await this._waitForReady(10000);
    if (!ready) {
      this.stop();
      throw new Error("Chrome failed to start within timeout");
    }

    this.wsEndpoint = await this.getWSEndpoint();
    this.restartAttempts = 0;
    this.restartDelay = INITIAL_RESTART_DELAY;

    console.log(
      `[BrowserServer] Chrome ready at ws endpoint: ${this.wsEndpoint}`,
    );
    this.emit("started", { wsEndpoint: this.wsEndpoint });
    this._startHealthCheck();
  }

  async stop() {
    this._intentionalStop = true;
    this._stopHealthCheck();

    if (this.process) {
      console.log("[BrowserServer] Stopping Chrome...");
      try {
        this.process.kill("SIGTERM");
        // Give it 3 seconds to exit gracefully
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (this.process) {
              this.process.kill("SIGKILL");
            }
            resolve();
          }, 3000);
          if (this.process) {
            this.process.once("exit", () => {
              clearTimeout(timeout);
              resolve();
            });
          } else {
            clearTimeout(timeout);
            resolve();
          }
        });
      } catch (err) {
        console.error("[BrowserServer] Error stopping Chrome:", err.message);
      }
      this.process = null;
    }
    this.wsEndpoint = null;
    this.emit("stopped");
  }

  async getWSEndpoint() {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${this.port}/json/version`,
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve(json.webSocketDebuggerUrl || null);
            } catch {
              reject(new Error("Invalid JSON from /json/version"));
            }
          });
        },
      );
      req.on("error", (err) => reject(err));
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Timeout getting WS endpoint"));
      });
    });
  }

  async listPages() {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${this.port}/json/list`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const pages = JSON.parse(data);
            resolve(
              pages
                .filter((p) => p.type === "page")
                .map((p) => ({
                  id: p.id,
                  url: p.url,
                  title: p.title,
                  wsUrl: p.webSocketDebuggerUrl,
                })),
            );
          } catch {
            reject(new Error("Invalid JSON from /json/list"));
          }
        });
      });
      req.on("error", (err) => reject(err));
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Timeout listing pages"));
      });
    });
  }

  async healthCheck() {
    try {
      await this.getWSEndpoint();
      return true;
    } catch {
      return false;
    }
  }

  isRunning() {
    // Either we have a managed process OR we adopted an external Chrome
    return (this.process && !this.process.killed) || this.wsEndpoint !== null;
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthCheckTimer = setInterval(async () => {
      const healthy = await this.healthCheck();
      if (!healthy) {
        console.warn("[BrowserServer] Health check failed");
        this.emit("unhealthy");
        // If we adopted an external Chrome and it's gone, clear state
        if (!this.process) {
          this._stopHealthCheck();
          this.wsEndpoint = null;
          this.emit("stopped");
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  _stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  async _waitForReady(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.getWSEndpoint();
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return false;
  }

  async _tryExistingChrome() {
    try {
      const ws = await this.getWSEndpoint();
      return ws;
    } catch {
      return null;
    }
  }

  _scheduleRestart() {
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error(
        `[BrowserServer] Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached`,
      );
      this.emit("restart-failed");
      return;
    }

    this.restartAttempts++;
    const delay = this.restartDelay * Math.pow(2, this.restartAttempts - 1);
    console.log(
      `[BrowserServer] Scheduling restart attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${delay}ms`,
    );

    setTimeout(async () => {
      try {
        await this.start();
      } catch (err) {
        console.error("[BrowserServer] Restart failed:", err.message);
      }
    }, delay);
  }

  _findChromePath() {
    const candidates = [
      "google-chrome-stable",
      "google-chrome",
      "chromium-browser",
      "chromium",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/opt/google/chrome/chrome",
    ];

    for (const candidate of candidates) {
      try {
        const resolved = execSync(`which ${candidate} 2>/dev/null`, {
          encoding: "utf-8",
        }).trim();
        if (resolved) return resolved;
      } catch {
        // Not found, try next
      }
    }

    return null;
  }
}

export const browserServer = new BrowserServer();
export default browserServer;
