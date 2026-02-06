/**
 * Puppeteer Service - Dual-mode browser automation
 * Mode 1 (MCP): Uses the puppeteer MCP server for headless Chrome control (original)
 * Mode 2 (Shared): Connects directly to shared Chrome via CDP using puppeteer-core
 */

import { MCPClient } from "./mcp-client.js";
import puppeteer from "puppeteer-core";
import { browserServer } from "./browser-server.js";

// ============================================
// MCP Mode State (original)
// ============================================
let puppeteerClient = null;

// ============================================
// Shared Mode State
// ============================================
let connectionMode = "mcp"; // "mcp" | "shared"
let sharedBrowser = null; // puppeteer-core Browser instance
let sharedPage = null; // active Page in shared browser
let activityCallback = null; // callback for activity logging

// ============================================
// Public API: Mode Management
// ============================================

export function setActivityCallback(cb) {
  activityCallback = cb;
}

export function getMode() {
  return connectionMode;
}

function logActivity(source, action, details = {}) {
  if (activityCallback) {
    activityCallback(source, action, details);
  }
}

export async function switchToShared() {
  try {
    if (!browserServer.isRunning()) {
      await browserServer.start();
    }

    const wsEndpoint =
      browserServer.wsEndpoint || (await browserServer.getWSEndpoint());
    if (!wsEndpoint) {
      throw new Error("No WebSocket endpoint available from shared browser");
    }

    sharedBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    console.log("[Puppeteer] Connected to shared browser");

    // Get first page or create one
    const pages = await sharedBrowser.pages();
    sharedPage = pages.length > 0 ? pages[0] : await sharedBrowser.newPage();

    connectionMode = "shared";
    return { success: true, mode: "shared" };
  } catch (err) {
    console.error("[Puppeteer] Failed to switch to shared mode:", err.message);
    return { success: false, error: err.message };
  }
}

export async function switchToMCP() {
  try {
    if (sharedBrowser) {
      sharedBrowser.disconnect(); // disconnect, don't close (Chrome stays running)
      sharedBrowser = null;
      sharedPage = null;
    }
    connectionMode = "mcp";
    console.log("[Puppeteer] Switched to MCP mode");
    return { success: true, mode: "mcp" };
  } catch (err) {
    console.error("[Puppeteer] Error switching to MCP:", err.message);
    connectionMode = "mcp";
    return { success: false, error: err.message };
  }
}

export async function listPages() {
  if (connectionMode === "shared") {
    try {
      return await browserServer.listPages();
    } catch (err) {
      console.error("[Puppeteer] Error listing pages:", err.message);
      return [];
    }
  }
  return [];
}

export async function selectPage(pageId) {
  if (connectionMode !== "shared" || !sharedBrowser) {
    return { success: false, error: "Not in shared mode" };
  }

  try {
    const pages = await sharedBrowser.pages();
    const targets = await sharedBrowser.targets();

    for (let i = 0; i < pages.length; i++) {
      const target = targets.find(
        (t) => t.type() === "page" && t._targetId === pageId,
      );
      if (target) {
        sharedPage = pages[i] || (await target.page());
        await sharedPage.bringToFront();
        return {
          success: true,
          page: {
            id: pageId,
            url: sharedPage.url(),
            title: await sharedPage.title(),
          },
        };
      }
    }

    // Fallback: try matching by page URL from CDP listing
    const cdpPages = await browserServer.listPages();
    const match = cdpPages.find((p) => p.id === pageId);
    if (match && match.wsUrl) {
      // Connect to specific page via its WS URL
      const page = await sharedBrowser
        .pages()
        .then((pp) => pp.find((p) => p.url() === match.url));
      if (page) {
        sharedPage = page;
        await sharedPage.bringToFront();
        return {
          success: true,
          page: { id: pageId, url: match.url, title: match.title },
        };
      }
    }

    return { success: false, error: "Page not found" };
  } catch (err) {
    console.error("[Puppeteer] Error selecting page:", err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// MCP Mode Helpers (original)
// ============================================

export function getPuppeteerClient() {
  if (!puppeteerClient) {
    puppeteerClient = new MCPClient("mcp-server-puppeteer", []);
  }
  return puppeteerClient;
}

async function ensureConnected() {
  const client = getPuppeteerClient();
  if (!client.connected || !client.initialized) {
    await client.connect();
  }
  return client;
}

// ============================================
// Shared Mode Helper
// ============================================

async function ensureSharedPage() {
  if (!sharedBrowser || !sharedPage) {
    // Try reconnecting
    const result = await switchToShared();
    if (!result.success) {
      throw new Error(
        "Shared browser not available: " + (result.error || "unknown"),
      );
    }
  }
  return sharedPage;
}

// Wrapper that falls back to MCP on shared mode failure
async function withSharedFallback(sharedFn, mcpFn) {
  if (connectionMode === "shared") {
    try {
      return await sharedFn();
    } catch (err) {
      console.warn(
        "[Puppeteer] Shared mode error, falling back to MCP:",
        err.message,
      );
      connectionMode = "mcp";
      sharedBrowser = null;
      sharedPage = null;
      return await mcpFn();
    }
  }
  return await mcpFn();
}

// ============================================
// Dual-Mode Browser Functions
// ============================================

export async function navigate(url) {
  return withSharedFallback(
    () => navigateShared(url),
    () => navigateMCP(url),
  );
}

export async function takeScreenshot(options = {}) {
  return withSharedFallback(
    () => takeScreenshotShared(options),
    () => takeScreenshotMCP(options),
  );
}

export async function click(selector) {
  return withSharedFallback(
    () => clickShared(selector),
    () => clickMCP(selector),
  );
}

export async function fill(selector, value) {
  return withSharedFallback(
    () => fillShared(selector, value),
    () => fillMCP(selector, value),
  );
}

export async function hover(selector) {
  return withSharedFallback(
    () => hoverShared(selector),
    () => hoverMCP(selector),
  );
}

export async function evaluate(script) {
  return withSharedFallback(
    () => evaluateShared(script),
    () => evaluateMCP(script),
  );
}

export async function select(selector, value) {
  return withSharedFallback(
    () => selectShared(selector, value),
    () => selectMCP(selector, value),
  );
}

export async function clickAt(x, y) {
  return withSharedFallback(
    () => clickAtShared(x, y),
    () => clickAtMCP(x, y),
  );
}

// ============================================
// Shared Mode Implementations
// ============================================

async function navigateShared(url) {
  try {
    if (!url || typeof url !== "string") {
      return { success: false, error: "Invalid URL" };
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const page = await ensureSharedPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    logActivity("user", "navigate", { url });
    return { success: true, url };
  } catch (err) {
    console.error("[Puppeteer/Shared] Navigate error:", err.message);
    return { success: false, error: err.message };
  }
}

async function takeScreenshotShared(options = {}) {
  try {
    const page = await ensureSharedPage();

    if (options.width || options.height) {
      await page.setViewport({
        width: options.width || 1280,
        height: options.height || 800,
      });
    }

    const buffer = await page.screenshot({
      encoding: "base64",
      type: "png",
      fullPage: false,
    });

    const dataUrl = `data:image/png;base64,${buffer}`;
    return { success: true, data: dataUrl };
  } catch (err) {
    console.error("[Puppeteer/Shared] Screenshot error:", err.message);
    return { success: false, error: err.message };
  }
}

async function clickShared(selector) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const page = await ensureSharedPage();
    await page.click(selector);
    logActivity("user", "click", { selector });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer/Shared] Click error:", err.message);
    return { success: false, error: err.message };
  }
}

async function fillShared(selector, value) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const page = await ensureSharedPage();
    await page.type(selector, value || "");
    logActivity("user", "fill", { selector, text: value });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer/Shared] Fill error:", err.message);
    return { success: false, error: err.message };
  }
}

async function hoverShared(selector) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const page = await ensureSharedPage();
    await page.hover(selector);
    logActivity("user", "hover", { selector });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer/Shared] Hover error:", err.message);
    return { success: false, error: err.message };
  }
}

async function evaluateShared(script) {
  try {
    if (!script || typeof script !== "string") {
      return { success: false, error: "Invalid script" };
    }

    const page = await ensureSharedPage();
    const result = await page.evaluate(script);
    return { success: true, result };
  } catch (err) {
    console.error("[Puppeteer/Shared] Evaluate error:", err.message);
    return { success: false, error: err.message };
  }
}

async function selectShared(selector, value) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const page = await ensureSharedPage();
    await page.select(selector, value || "");
    logActivity("user", "select", { selector, value });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer/Shared] Select error:", err.message);
    return { success: false, error: err.message };
  }
}

async function clickAtShared(x, y) {
  try {
    if (typeof x !== "number" || typeof y !== "number") {
      return { success: false, error: "Invalid coordinates" };
    }

    const page = await ensureSharedPage();
    await page.mouse.click(x, y);
    logActivity("user", "click", { x, y });

    // Get info about what was clicked
    const result = await page.evaluate(
      (cx, cy) => {
        const el = document.elementFromPoint(cx, cy);
        if (el) {
          return {
            clicked: true,
            tagName: el.tagName,
            id: el.id,
            className: el.className,
          };
        }
        return { clicked: false };
      },
      x,
      y,
    );

    return { success: true, result };
  } catch (err) {
    console.error("[Puppeteer/Shared] ClickAt error:", err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// MCP Mode Implementations (original code)
// ============================================

async function navigateMCP(url) {
  try {
    if (!url || typeof url !== "string") {
      return { success: false, error: "Invalid URL" };
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const client = await ensureConnected();
    const result = await client.callTool("puppeteer_navigate", { url });
    return { success: true, url, result };
  } catch (err) {
    console.error("[Puppeteer] Navigate error:", err.message);
    return { success: false, error: err.message };
  }
}

async function takeScreenshotMCP(options = {}) {
  try {
    const client = await ensureConnected();

    const params = {
      name: options.name || `screenshot_${Date.now()}`,
      encoded: true,
    };

    if (options.width) params.width = options.width;
    if (options.height) params.height = options.height;
    if (options.selector) params.selector = options.selector;

    const result = await client.callTool("puppeteer_screenshot", params);

    if (result && typeof result === "string") {
      const dataUrlIndex = result.indexOf("data:image/");
      if (dataUrlIndex !== -1) {
        const dataUrl = result.substring(dataUrlIndex);
        return { success: true, data: dataUrl };
      }
      if (result.startsWith("data:image/")) {
        return { success: true, data: result };
      }
    }

    if (result?.content && Array.isArray(result.content)) {
      const imageContent = result.content.find((c) => c.type === "image");
      if (imageContent?.data) {
        const dataUrl = `data:${imageContent.mimeType || "image/png"};base64,${imageContent.data}`;
        return { success: true, data: dataUrl };
      }
    }

    if (result?.data) {
      if (result.data.startsWith("data:image/")) {
        return { success: true, data: result.data };
      }
      return { success: true, data: `data:image/png;base64,${result.data}` };
    }

    return { success: false, error: "No image data in screenshot response" };
  } catch (err) {
    console.error("[Puppeteer] Screenshot error:", err.message);
    return { success: false, error: err.message };
  }
}

async function clickMCP(selector) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const client = await ensureConnected();
    await client.callTool("puppeteer_click", { selector });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer] Click error:", err.message);
    return { success: false, error: err.message };
  }
}

async function fillMCP(selector, value) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const client = await ensureConnected();
    await client.callTool("puppeteer_fill", { selector, value: value || "" });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer] Fill error:", err.message);
    return { success: false, error: err.message };
  }
}

async function hoverMCP(selector) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const client = await ensureConnected();
    await client.callTool("puppeteer_hover", { selector });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer] Hover error:", err.message);
    return { success: false, error: err.message };
  }
}

async function evaluateMCP(script) {
  try {
    if (!script || typeof script !== "string") {
      return { success: false, error: "Invalid script" };
    }

    const client = await ensureConnected();
    const result = await client.callTool("puppeteer_evaluate", { script });
    return { success: true, result };
  } catch (err) {
    console.error("[Puppeteer] Evaluate error:", err.message);
    return { success: false, error: err.message };
  }
}

async function selectMCP(selector, value) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const client = await ensureConnected();
    await client.callTool("puppeteer_select", {
      selector,
      value: value || "",
    });
    return { success: true };
  } catch (err) {
    console.error("[Puppeteer] Select error:", err.message);
    return { success: false, error: err.message };
  }
}

async function clickAtMCP(x, y) {
  try {
    if (typeof x !== "number" || typeof y !== "number") {
      return { success: false, error: "Invalid coordinates" };
    }

    const client = await ensureConnected();

    const script = `
      (function() {
        const el = document.elementFromPoint(${x}, ${y});
        if (el) {
          el.click();
          return { clicked: true, tagName: el.tagName, id: el.id, className: el.className };
        }
        return { clicked: false };
      })()
    `;

    const result = await client.callTool("puppeteer_evaluate", { script });
    return { success: true, result };
  } catch (err) {
    console.error("[Puppeteer] ClickAt error:", err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// Cleanup
// ============================================

export function cleanup() {
  if (puppeteerClient) {
    puppeteerClient.disconnect();
    puppeteerClient = null;
  }
  if (sharedBrowser) {
    sharedBrowser.disconnect();
    sharedBrowser = null;
    sharedPage = null;
  }
}

export default {
  getPuppeteerClient,
  getMode,
  setActivityCallback,
  switchToShared,
  switchToMCP,
  listPages,
  selectPage,
  navigate,
  takeScreenshot,
  click,
  fill,
  hover,
  evaluate,
  select,
  clickAt,
  cleanup,
};
