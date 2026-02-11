import { execFile, exec } from "child_process";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const ADB = join(homedir(), "Android/Sdk/platform-tools/adb");
const CONFIG_DIR = join(homedir(), ".claude/claude-web");
const CONFIG_PATH = join(CONFIG_DIR, "phone-config.json");
const CMD_TIMEOUT = 15000;

let connected = false;
let deviceSerial = null;
let originalScreenTimeout = null;

// ---- Helpers ----

/** Run ADB with argument array — safe from shell injection */
function adb(argsArray, timeout = CMD_TIMEOUT) {
  const args = deviceSerial ? ["-s", deviceSerial, ...argsArray] : argsArray;
  return new Promise((resolve, reject) => {
    execFile(ADB, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Run ADB with shell pipe — only for internal trusted commands */
function adbShellPipe(cmd, timeout = CMD_TIMEOUT) {
  const serial = deviceSerial ? `-s ${deviceSerial}` : "";
  return new Promise((resolve, reject) => {
    exec(`${ADB} ${serial} ${cmd}`, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Validate string contains only safe characters for ADB arguments */
function isSafeArg(str) {
  return /^[a-zA-Z0-9_.:\-/]+$/.test(str);
}

// ---- Config ----

export async function loadConfig() {
  try {
    const data = await readFile(CONFIG_PATH, "utf-8");
    const config = JSON.parse(data);
    // Never expose pin externally — redact on load for public use
    return { ip: config.ip || "", port: config.port || 5555 };
  } catch {
    return { ip: "", port: 5555 };
  }
}

/** Internal config loader that includes PIN (never expose to clients) */
async function loadConfigInternal() {
  try {
    const data = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return { ip: "", port: 5555, pin: null };
  }
}

export async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const data = JSON.stringify(config, null, 2);
  await writeFile(CONFIG_PATH, data, { mode: 0o600 });
}

// ---- Connection ----

export async function connect(ip, port = 5555) {
  // Validate IP format strictly
  if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    throw new Error("Invalid IP address format");
  }
  // Validate each octet is 0-255
  const octets = ip.split(".").map(Number);
  if (octets.some((o) => o < 0 || o > 255)) {
    throw new Error("IP address octets must be 0-255");
  }
  // Validate port
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error("Port must be 1-65535");
  }

  const target = `${ip}:${portNum}`;
  const result = await adb(["connect", target]);
  if (!result.includes("connected")) {
    throw new Error(`ADB connect failed: ${result}`);
  }
  deviceSerial = target;
  connected = true;

  // Verify the connection actually works
  try {
    await adb(["get-state"]);
  } catch {
    connected = false;
    deviceSerial = null;
    throw new Error("ADB connected but device not responding");
  }

  const existing = await loadConfigInternal();
  await saveConfig({
    ip,
    port: portNum,
    pin: existing.pin,
    lastConnected: new Date().toISOString(),
  });

  return { success: true, serial: target };
}

export async function disconnect() {
  if (originalScreenTimeout !== null) {
    await restoreScreenTimeout();
  }
  if (deviceSerial) {
    try {
      await adb(["disconnect", deviceSerial]);
    } catch {
      // ignore disconnect errors
    }
  }
  connected = false;
  deviceSerial = null;
  return { success: true };
}

export function isConnected() {
  return connected;
}

// ---- Wake & Screen Management ----

export async function wakeScreen() {
  // Send WAKEUP keyevent
  await adb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
  await sleep(300);
  // Swipe up to dismiss lock screen
  await adb(["shell", "input", "swipe", "540", "1800", "540", "800", "300"]);
  await sleep(200);

  // If PIN is configured, enter it (digits only)
  const config = await loadConfigInternal();
  if (config.pin) {
    const pin = String(config.pin).replace(/[^0-9]/g, "");
    if (pin) {
      await adb(["shell", "input", "text", pin]);
      await sleep(100);
      await adb(["shell", "input", "keyevent", "KEYCODE_ENTER"]);
      await sleep(300);
    }
  }

  return { success: true };
}

export async function keepScreenAwake() {
  const current = await adb([
    "shell",
    "settings",
    "get",
    "system",
    "screen_off_timeout",
  ]);
  originalScreenTimeout = parseInt(current, 10) || 30000;
  await adb([
    "shell",
    "settings",
    "put",
    "system",
    "screen_off_timeout",
    "600000",
  ]);
  return { success: true, originalTimeout: originalScreenTimeout };
}

export async function restoreScreenTimeout() {
  if (originalScreenTimeout !== null) {
    await adb([
      "shell",
      "settings",
      "put",
      "system",
      "screen_off_timeout",
      String(originalScreenTimeout),
    ]);
    originalScreenTimeout = null;
  }
  return { success: true };
}

// ---- App Control ----

export async function bringAppToFront(pkg) {
  if (!isSafeArg(pkg)) {
    throw new Error("Invalid package name");
  }
  await adb(["shell", "am", "start", "-n", `${pkg}/.MainActivity`]);
  return { success: true };
}

export async function returnToClaudeWeb() {
  return bringAppToFront("com.primeape.claudeweb");
}

// ---- Device Info ----

export async function getDeviceInfo() {
  const [model, version, batteryRaw, sizeRaw] = await Promise.all([
    adb(["shell", "getprop", "ro.product.model"]),
    adb(["shell", "getprop", "ro.build.version.release"]),
    adb(["shell", "dumpsys", "battery"]),
    adb(["shell", "wm", "size"]),
  ]);

  const batteryMatch = batteryRaw.match(/level:\s*(\d+)/);
  const battery = batteryMatch ? parseInt(batteryMatch[1], 10) : null;

  const sizeMatch = sizeRaw.match(/(\d+)x(\d+)/);
  const width = sizeMatch ? parseInt(sizeMatch[1], 10) : null;
  const height = sizeMatch ? parseInt(sizeMatch[2], 10) : null;

  return { model, version, battery, width, height };
}

// ---- Logcat ----

export async function streamLogcat(filter = "", lines = 50) {
  // Validate filter — only allow safe logcat tag characters
  if (filter && !/^[a-zA-Z0-9_.\-*]+$/.test(filter)) {
    throw new Error(
      "Invalid logcat filter — only alphanumeric, dots, dashes, underscores, and * allowed",
    );
  }
  // Validate and cap lines
  const maxLines = Math.min(Math.max(parseInt(lines, 10) || 50, 1), 10000);

  const args = ["logcat", "-d", "-t", String(maxLines)];
  if (filter) {
    args.push(`${filter}:V`, "*:S");
  }
  return adb(args);
}

// ---- Screenshot (fallback when Appium session isn't active) ----

export async function takeScreenshot() {
  // This needs a shell pipe for base64 encoding
  return adbShellPipe("exec-out screencap -p | base64", CMD_TIMEOUT);
}
