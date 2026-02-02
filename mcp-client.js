/**
 * MCP Client - JSON-RPC 2.0 communication over stdio with mcp-server-memory
 */

import { spawn } from "child_process";
import { EventEmitter } from "events";

const DEFAULT_TIMEOUT = 30000; // 30 seconds

class MCPClient extends EventEmitter {
  constructor(command = "mcp-server-memory", args = []) {
    super();
    this.command = command;
    this.args = args;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = "";
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.initialized = false;
  }

  /**
   * Connect to the MCP server
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        this.process.stdout.setEncoding("utf8");
        this.process.stderr.setEncoding("utf8");

        // Handle stdout data (JSON-RPC responses)
        this.process.stdout.on("data", (data) => {
          this.handleData(data);
        });

        // Handle stderr (logging, errors)
        this.process.stderr.on("data", (data) => {
          console.error(`[MCP stderr] ${data}`);
        });

        // Handle process errors
        this.process.on("error", (err) => {
          console.error(`[MCP] Process error: ${err.message}`);
          this.connected = false;
          this.initialized = false;
          this.emit("error", err);
          reject(err);
        });

        // Handle process exit
        this.process.on("exit", (code, signal) => {
          console.log(
            `[MCP] Process exited with code ${code}, signal ${signal}`,
          );
          this.connected = false;
          this.initialized = false;

          // Reject all pending requests
          for (const [id, { reject }] of this.pendingRequests) {
            reject(new Error("MCP server process exited"));
          }
          this.pendingRequests.clear();

          this.emit("disconnected");

          // Attempt reconnect if not intentional disconnect
          if (
            code !== 0 &&
            this.reconnectAttempts < this.maxReconnectAttempts
          ) {
            this.scheduleReconnect();
          }
        });

        // Use spawn event to know when process is ready (more reliable than timeout)
        this.process.on("spawn", async () => {
          this.connected = true;
          this.reconnectAttempts = 0;

          try {
            // Initialize the MCP connection with timeout
            const initTimeout = setTimeout(() => {
              reject(new Error("MCP initialization timeout"));
            }, 10000); // 10 second timeout for initialization

            await this.initialize();
            clearTimeout(initTimeout);
            this.emit("connected");
            resolve();
          } catch (err) {
            console.error("[MCP] Initialization failed:", err);
            this.connected = false;
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Initialize the MCP connection (handshake)
   */
  async initialize() {
    if (this.initialized) return;

    // Send initialize request
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "claude-web",
        version: "1.0.0",
      },
    });

    // Send initialized notification
    await this.sendNotification("notifications/initialized", {});

    this.initialized = true;
    console.log("[MCP] Connection initialized");
    return result;
  }

  /**
   * Disconnect from the MCP server
   */
  disconnect() {
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this.initialized = false;
    this.pendingRequests.clear();
  }

  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(
      `[MCP] Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );

    setTimeout(async () => {
      try {
        await this.connect();
        console.log("[MCP] Reconnected successfully");
      } catch (err) {
        console.error("[MCP] Reconnect failed:", err.message);
      }
    }, delay);
  }

  /**
   * Handle incoming data from stdout
   */
  handleData(data) {
    this.buffer += data;

    // Process complete JSON-RPC messages (newline-delimited)
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (err) {
          console.error("[MCP] Failed to parse message:", line, err);
        }
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  handleMessage(message) {
    // Check if it's a response to a pending request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message || "RPC Error"));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      // It's a notification from the server
      this.emit("notification", message);
    }
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  sendRequest(method, params = {}, timeout = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.process) {
        reject(new Error("MCP client not connected"));
        return;
      }

      const id = ++this.requestId;
      const request = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      // Store pending request
      this.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });

      // Send request
      try {
        this.process.stdin.write(JSON.stringify(request) + "\n");
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  async sendNotification(method, params = {}) {
    if (!this.connected || !this.process) {
      throw new Error("MCP client not connected");
    }

    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    this.process.stdin.write(JSON.stringify(notification) + "\n");
  }

  /**
   * Call an MCP tool
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @param {boolean} raw - Return raw result with full content array
   * @returns {Promise<any>}
   */
  async callTool(name, args = {}, raw = false) {
    if (!this.initialized) {
      await this.connect();
    }

    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });

    // Return raw result if requested (useful for screenshots, etc.)
    if (raw) {
      return result;
    }

    // Extract content from result
    if (result?.content && Array.isArray(result.content)) {
      // Check for image content first (for screenshots, etc.)
      const imageContent = result.content.find((c) => c.type === "image");
      if (imageContent) {
        // Return full content array when image is present
        return result;
      }

      // Check if any text content contains a data URL (puppeteer returns image as text)
      const dataUrlContent = result.content.find(
        (c) => c.type === "text" && c.text?.startsWith("data:image/"),
      );
      if (dataUrlContent) {
        // Return the data URL directly
        return dataUrlContent.text;
      }

      // Return text content if available
      const textContent = result.content.find((c) => c.type === "text");
      if (textContent) {
        // Try to parse as JSON
        try {
          return JSON.parse(textContent.text);
        } catch {
          return textContent.text;
        }
      }
      return result.content;
    }

    return result;
  }

  /**
   * List available tools
   * @returns {Promise<Array>}
   */
  async listTools() {
    if (!this.initialized) {
      await this.connect();
    }

    const result = await this.sendRequest("tools/list", {});
    return result?.tools || [];
  }
}

// Singleton instance for the memory server
let memoryClient = null;

/**
 * Get or create the MCP memory client singleton
 * @returns {MCPClient}
 */
export function getMemoryClient() {
  if (!memoryClient) {
    memoryClient = new MCPClient("mcp-server-memory", []);
  }
  return memoryClient;
}

/**
 * Disconnect and cleanup the memory client
 */
export function disconnectMemoryClient() {
  if (memoryClient) {
    memoryClient.disconnect();
    memoryClient = null;
  }
}

export { MCPClient };
export default MCPClient;
