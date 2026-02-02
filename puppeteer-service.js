/**
 * Puppeteer Service - MCP wrapper for browser automation
 * Uses the puppeteer MCP server for headless Chrome control
 */

import { MCPClient } from "./mcp-client.js";

// Singleton instance for the puppeteer server
let puppeteerClient = null;

/**
 * Get or create the Puppeteer MCP client singleton
 * @returns {MCPClient}
 */
export function getPuppeteerClient() {
  if (!puppeteerClient) {
    puppeteerClient = new MCPClient("mcp-server-puppeteer", []);
  }
  return puppeteerClient;
}

/**
 * Ensure client is connected
 */
async function ensureConnected() {
  const client = getPuppeteerClient();
  if (!client.connected || !client.initialized) {
    await client.connect();
  }
  return client;
}

/**
 * Navigate to a URL
 * @param {string} url - URL to navigate to
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export async function navigate(url) {
  try {
    // Validate URL
    if (!url || typeof url !== "string") {
      return { success: false, error: "Invalid URL" };
    }

    // Only allow http/https protocols
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      // Try prepending https
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

/**
 * Take a screenshot of the current page
 * @param {object} options - Screenshot options
 * @param {string} [options.name] - Screenshot name
 * @param {number} [options.width] - Width in pixels
 * @param {number} [options.height] - Height in pixels
 * @param {string} [options.selector] - CSS selector to screenshot
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
export async function takeScreenshot(options = {}) {
  try {
    const client = await ensureConnected();

    const params = {
      name: options.name || `screenshot_${Date.now()}`,
      encoded: true, // Get base64 data URI
    };

    if (options.width) params.width = options.width;
    if (options.height) params.height = options.height;
    if (options.selector) params.selector = options.selector;

    const result = await client.callTool("puppeteer_screenshot", params);

    // The MCP server may return the data URL as a string or in content array
    // We need to extract the data URL from within the result
    if (result && typeof result === "string") {
      // Look for the data URL within the string
      const dataUrlIndex = result.indexOf("data:image/");
      if (dataUrlIndex !== -1) {
        const dataUrl = result.substring(dataUrlIndex);
        return { success: true, data: dataUrl };
      }
      // If it starts with data:image, use as-is
      if (result.startsWith("data:image/")) {
        return { success: true, data: result };
      }
    }

    // Handle content array format (MCP standard format) as fallback
    if (result?.content && Array.isArray(result.content)) {
      const imageContent = result.content.find((c) => c.type === "image");
      if (imageContent?.data) {
        const dataUrl = `data:${imageContent.mimeType || "image/png"};base64,${imageContent.data}`;
        return { success: true, data: dataUrl };
      }
    }

    // If result is an object with data property
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

/**
 * Click on an element
 * @param {string} selector - CSS selector for element to click
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function click(selector) {
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

/**
 * Fill an input field
 * @param {string} selector - CSS selector for input field
 * @param {string} value - Value to fill
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function fill(selector, value) {
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

/**
 * Hover over an element
 * @param {string} selector - CSS selector for element to hover
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function hover(selector) {
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

/**
 * Execute JavaScript in the browser context
 * @param {string} script - JavaScript code to execute
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
export async function evaluate(script) {
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

/**
 * Select a value in a dropdown
 * @param {string} selector - CSS selector for select element
 * @param {string} value - Value to select
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function select(selector, value) {
  try {
    if (!selector || typeof selector !== "string") {
      return { success: false, error: "Invalid selector" };
    }

    const client = await ensureConnected();
    await client.callTool("puppeteer_select", { selector, value: value || "" });

    return { success: true };
  } catch (err) {
    console.error("[Puppeteer] Select error:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Click at specific coordinates (useful for screenshot-based interaction)
 * This evaluates JavaScript to trigger a click at the given position
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function clickAt(x, y) {
  try {
    if (typeof x !== "number" || typeof y !== "number") {
      return { success: false, error: "Invalid coordinates" };
    }

    const client = await ensureConnected();

    // Use evaluate to dispatch a click event at the coordinates
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

/**
 * Clean up and disconnect the puppeteer client
 */
export function cleanup() {
  if (puppeteerClient) {
    puppeteerClient.disconnect();
    puppeteerClient = null;
  }
}

export default {
  getPuppeteerClient,
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
