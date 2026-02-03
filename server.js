import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { readdir, stat, readFile, writeFile, unlink, mkdir } from "fs/promises";
import { homedir } from "os";
import webpush from "web-push";
import { socketAuthMiddleware } from "./auth.js";
import {
  createSession,
  runClaudeCommand,
  stopSession,
  loadPersistedSessions,
  listSessions,
  restoreSession,
  getSession,
  getBufferedResponse,
  clearBuffer,
  setSessionModel,
} from "./claude-runner.js";
import {
  readGraph,
  searchNodes,
  getEntity,
  invalidateCache as invalidateMemoryCache,
} from "./memory-service.js";
import * as puppeteerService from "./puppeteer-service.js";
import {
  initDatabase,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  getActiveProjectId,
  setActiveProjectId,
  getActiveProject,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  linkConversation,
  unlinkConversation,
  getConversationLink,
  getAllConversationLinks,
  listConversationLinks,
  moveConversationToFolder,
} from "./database.js";

// Configure web-push with VAPID keys
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:claude-web@localhost",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  console.log("Push notifications enabled");
} else {
  console.log("Push notifications disabled (no VAPID keys)");
}

// Store push subscriptions per SESSION (sessionId -> subscription)
// This persists even when socket disconnects (e.g., phone screen off)
const pushSubscriptions = new Map();
// Track client visibility per SESSION (sessionId -> boolean)
const clientVisibility = new Map();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOME = homedir();
const HISTORY_DIR = join(HOME, ".claude", "claude-web", "history");
const UPLOADS_DIR = join(HOME, ".claude", "claude-web", "uploads");
const SCREENSHOTS_DIR = join(HOME, ".claude", "claude-web", "screenshots");
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Ensure directories exist
mkdir(UPLOADS_DIR, { recursive: true }).catch(() => {});
mkdir(SCREENSHOTS_DIR, { recursive: true }).catch(() => {});

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS =
  parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS =
  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 20; // 20 requests per window

// Retry configuration
const RETRY_MAX_ATTEMPTS = parseInt(process.env.RETRY_MAX_ATTEMPTS) || 3;
const RETRY_BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS) || 1000; // 1 second
const RETRY_MAX_DELAY_MS = parseInt(process.env.RETRY_MAX_DELAY_MS) || 30000; // 30 seconds

// Helper: sleep for ms
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: calculate exponential backoff delay
function getRetryDelay(attempt) {
  const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  // Add jitter (±10%) to prevent thundering herd
  const jitter = delay * 0.2 * (Math.random() - 0.5);
  return Math.min(delay + jitter, RETRY_MAX_DELAY_MS);
}

// Track active retry operations per session (to prevent concurrent retries)
const activeRetries = new Map(); // sessionId -> AbortController

// Rate limiter class using sliding window
class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map(); // socketId -> timestamp array
  }

  isAllowed(socketId) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get or create request history for this socket
    let history = this.requests.get(socketId) || [];

    // Filter out old requests outside the window
    history = history.filter((timestamp) => timestamp > windowStart);

    // Check if under limit
    if (history.length >= this.maxRequests) {
      this.requests.set(socketId, history);
      return {
        allowed: false,
        remaining: 0,
        resetIn: Math.ceil((history[0] + this.windowMs - now) / 1000),
      };
    }

    // Add current request
    history.push(now);
    this.requests.set(socketId, history);

    return {
      allowed: true,
      remaining: this.maxRequests - history.length,
      resetIn: Math.ceil(this.windowMs / 1000),
    };
  }

  cleanup(socketId) {
    this.requests.delete(socketId);
  }
}

const rateLimiter = new RateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
);

// Ensure history directory exists
mkdir(HISTORY_DIR, { recursive: true }).catch(() => {});

// Validate ID format (alphanumeric, dashes, underscores only - no path traversal)
function isValidId(id) {
  if (!id || typeof id !== "string") return false;
  // Only allow alphanumeric, dashes, underscores, dots (no slashes or ..)
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 100;
}

// Validate UUID format specifically
function isValidUUID(id) {
  if (!id || typeof id !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

// Expand ~ in paths
function expandPath(path) {
  if (path.startsWith("~")) {
    return path.replace("~", HOME);
  }
  return path;
}

// Generate title from first user message
function generateTitle(messages) {
  const firstUser = messages?.find((m) => m.type === "user");
  if (firstUser?.content) {
    const text = firstUser.content.substring(0, 50);
    return text.length < firstUser.content.length ? text + "..." : text;
  }
  return `Chat ${new Date().toLocaleDateString()}`;
}

// Serve static files with no-cache for development
app.use(
  express.static(join(__dirname, "public"), {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    },
  }),
);

// API endpoint for serving screenshots
app.get("/api/images/:id", async (req, res) => {
  const { id } = req.params;

  // Validate ID format (prevent path traversal) - allow alphanumeric, dashes, underscores, and .png/.jpg extension
  if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/i.test(id)) {
    return res.status(400).json({ error: "Invalid image ID" });
  }

  const filepath = join(SCREENSHOTS_DIR, id);

  try {
    const data = await readFile(filepath);

    // Determine content type from extension
    const ext = id.split(".").pop().toLowerCase();
    const contentTypes = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };

    res.setHeader("Content-Type", contentTypes[ext] || "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
    res.send(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).json({ error: "Image not found" });
    } else {
      res.status(500).json({ error: "Failed to read image" });
    }
  }
});

// API endpoint to list available screenshots
app.get("/api/images", async (req, res) => {
  try {
    const files = await readdir(SCREENSHOTS_DIR);
    const images = [];

    for (const file of files) {
      if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(file)) continue;
      try {
        const filepath = join(SCREENSHOTS_DIR, file);
        const stats = await stat(filepath);
        images.push({
          id: file,
          url: `/api/images/${file}`,
          size: stats.size,
          created: stats.mtime,
        });
      } catch (e) {
        // Skip files we can't stat
      }
    }

    // Sort by most recent first
    images.sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ images });
  } catch (err) {
    res.json({ images: [] });
  }
});

// Cleanup old screenshots periodically
async function cleanupOldScreenshots() {
  try {
    const files = await readdir(SCREENSHOTS_DIR);
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(file)) continue;
      try {
        const filepath = join(SCREENSHOTS_DIR, file);
        const stats = await stat(filepath);
        if (now - stats.mtimeMs > SCREENSHOT_MAX_AGE_MS) {
          await unlink(filepath);
          cleaned++;
        }
      } catch (e) {
        // Skip files we can't process
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} old screenshots`);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

// Run cleanup every hour
setInterval(cleanupOldScreenshots, 60 * 60 * 1000);
// Also run on startup
cleanupOldScreenshots();

// Socket.io authentication
io.use(socketAuthMiddleware);

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  let sessionId = null;
  let currentWorkingDir = HOME;

  socket.on("start-session", (data) => {
    currentWorkingDir = expandPath(data?.workingDir || HOME);
    // Validate model - only allow known values
    const validModels = ["opus", "sonnet", "haiku"];
    const model = validModels.includes(data?.model) ? data.model : "opus";
    sessionId = createSession(currentWorkingDir, model);
    socket.emit("session-started", {
      sessionId,
      workingDir: currentWorkingDir,
      model,
    });
    console.log(
      `Session started: ${sessionId} in ${currentWorkingDir} (model: ${model})`,
    );
  });

  // Restore an existing session by ID
  socket.on("restore-session", (data) => {
    // Validate session ID format to prevent manipulation
    if (!isValidUUID(data?.sessionId)) {
      socket.emit("session-restore-failed", { message: "Invalid session ID" });
      return;
    }
    const existingSession = restoreSession(data.sessionId);
    if (existingSession) {
      sessionId = existingSession.id;
      currentWorkingDir = existingSession.workingDir;
      socket.emit("session-restored", {
        sessionId,
        workingDir: currentWorkingDir,
        messageCount: existingSession.history.length,
        hasClaudeSession: !!existingSession.claudeSessionId,
      });
      console.log(
        `Session restored: ${sessionId} (${existingSession.history.length} messages)`,
      );
    } else {
      socket.emit("session-restore-failed", { message: "Session not found" });
    }
  });

  // List available sessions
  socket.on("list-sessions", async () => {
    const sessions = await listSessions();
    socket.emit("sessions-list", { sessions });
  });

  // Handle push subscription (stored per session, persists through disconnects)
  socket.on("push-subscribe", (data) => {
    if (data?.subscription && sessionId) {
      pushSubscriptions.set(sessionId, data.subscription);
      console.log(`[${sessionId}] Push subscription registered`);
    }
  });

  // Handle push unsubscription
  socket.on("push-unsubscribe", () => {
    if (sessionId) {
      pushSubscriptions.delete(sessionId);
      console.log(`[${sessionId}] Push subscription removed`);
    }
  });

  // Handle visibility change (stored per session, persists through disconnects)
  socket.on("visibility-change", (data) => {
    if (sessionId) {
      clientVisibility.set(sessionId, data?.visible ?? true);
      console.log(
        `[${sessionId}] Visibility: ${data?.visible ? "visible" : "hidden"}`,
      );
    }
  });

  // Get buffered response (for reconnection after disconnect)
  socket.on("get-buffered-response", () => {
    if (!sessionId) {
      socket.emit("buffered-response", { chunks: [], isComplete: false });
      return;
    }

    const buffer = getBufferedResponse(sessionId);
    if (buffer && buffer.chunks.length > 0) {
      socket.emit("buffered-response", buffer);
      // Clear buffer after sending
      if (buffer.isComplete) {
        clearBuffer(sessionId);
      }
      console.log(
        `[${sessionId}] Sent ${buffer.chunks.length} buffered chunks (complete: ${buffer.isComplete})`,
      );
    } else {
      socket.emit("buffered-response", { chunks: [], isComplete: false });
    }
  });

  // Handle image uploads
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
  const MAX_IMAGES_PER_REQUEST = 5;

  socket.on("upload-images", async (data) => {
    try {
      const { images } = data; // Array of { name, data (base64), type }
      if (!images || !Array.isArray(images) || images.length === 0) {
        socket.emit("upload-error", { message: "No images provided" });
        return;
      }

      if (images.length > MAX_IMAGES_PER_REQUEST) {
        socket.emit("upload-error", {
          message: `Maximum ${MAX_IMAGES_PER_REQUEST} images per message`,
        });
        return;
      }

      const uploadedPaths = [];
      const timestamp = Date.now();

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        // Validate image type (allow image/* including svg+xml)
        if (!img.type || !img.type.startsWith("image/")) {
          continue;
        }

        // Check size (base64 is ~33% larger than binary)
        const estimatedSize = (img.data.length * 3) / 4;
        if (estimatedSize > MAX_IMAGE_SIZE) {
          socket.emit("upload-error", {
            message: `Image too large (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`,
          });
          return;
        }

        // Generate safe filename - extract extension from MIME type
        const ext = img.type.split("/")[1]?.split("+")[0] || "png";
        const safeExt = ext.replace(/[^a-z0-9]/gi, "").substring(0, 10);
        const filename = `${timestamp}_${i}.${safeExt}`;
        const filepath = join(UPLOADS_DIR, filename);

        // Decode base64 and save (handle both data URL and raw base64)
        const base64Data = img.data.replace(/^data:image\/[^;]+;base64,/, "");
        await writeFile(filepath, Buffer.from(base64Data, "base64"));
        uploadedPaths.push(filepath);
      }

      socket.emit("upload-complete", { paths: uploadedPaths });
      console.log(`[${sessionId}] Uploaded ${uploadedPaths.length} images`);
    } catch (err) {
      socket.emit("upload-error", { message: err.message });
      console.error(`Upload error: ${err.message}`);
    }
  });

  socket.on("message", (data) => {
    if (!sessionId) {
      socket.emit("error", { message: "No active session" });
      return;
    }

    // Rate limiting check
    const rateCheck = rateLimiter.isAllowed(socket.id);
    if (!rateCheck.allowed) {
      socket.emit("rate-limited", {
        message: `Rate limit exceeded. Try again in ${rateCheck.resetIn} seconds.`,
        resetIn: rateCheck.resetIn,
      });
      console.log(
        `[${sessionId}] Rate limited (reset in ${rateCheck.resetIn}s)`,
      );
      return;
    }

    const prompt = data.prompt;
    const imagePaths = data.imagePaths || []; // Array of uploaded image paths

    if (!prompt && imagePaths.length === 0) {
      socket.emit("error", { message: "No prompt or images provided" });
      return;
    }

    // Build enhanced prompt with active project context
    let enhancedPrompt = prompt;
    const activeProject = getActiveProject();
    if (activeProject) {
      // Get pending and in-progress tasks for the active project
      const pendingTasks = listTasks(activeProject.id, { status: "pending" });
      const inProgressTasks = listTasks(activeProject.id, {
        status: "in_progress",
      });

      if (pendingTasks.length > 0 || inProgressTasks.length > 0) {
        let taskContext = `<project-tasks project="${activeProject.name}">\n`;

        if (inProgressTasks.length > 0) {
          taskContext += `In Progress:\n`;
          for (const task of inProgressTasks) {
            taskContext += `- [${task.priority.toUpperCase()}] ${task.title}`;
            if (task.description) taskContext += `: ${task.description}`;
            taskContext += "\n";
          }
        }

        if (pendingTasks.length > 0) {
          taskContext += `Pending (${pendingTasks.length}):\n`;
          // Show up to 10 pending tasks to avoid overwhelming context
          for (const task of pendingTasks.slice(0, 10)) {
            taskContext += `- [${task.priority.toUpperCase()}] ${task.title}`;
            if (task.description) taskContext += `: ${task.description}`;
            taskContext += "\n";
          }
          if (pendingTasks.length > 10) {
            taskContext += `... and ${pendingTasks.length - 10} more pending tasks\n`;
          }
        }

        taskContext += `</project-tasks>\n\n`;
        enhancedPrompt = taskContext + prompt;
      }
    }

    const imageInfo =
      imagePaths.length > 0 ? ` +${imagePaths.length} images` : "";
    console.log(
      `[${sessionId}] Prompt: ${(prompt || "").substring(0, 50)}...${imageInfo} (${rateCheck.remaining} remaining)`,
    );

    socket.emit("response-start");

    // Cancel any existing retry operation for this session
    if (activeRetries.has(sessionId)) {
      activeRetries.get(sessionId).abort();
      activeRetries.delete(sessionId);
    }

    // Create abort controller for this retry operation
    const abortController = new AbortController();
    activeRetries.set(sessionId, abortController);

    // Retry wrapper for runClaudeCommand
    let attempt = 0;
    let lastError = null;
    let hasReceivedData = false;

    const attemptCommand = async () => {
      hasReceivedData = false; // Reset for each attempt
      return new Promise((resolve) => {
        runClaudeCommand(
          sessionId,
          enhancedPrompt || "What do you see in this image?",
          imagePaths,
          (chunk) => {
            hasReceivedData = true;
            socket.emit("response-chunk", chunk);
          },
          async (code) => {
            // If we received data, don't retry (even on non-zero exit)
            // This prevents losing partial responses
            if (hasReceivedData || code === 0) {
              resolve({ success: true, code });
            } else {
              // No data received and non-zero exit - this is retryable
              resolve({
                success: false,
                error: new Error(`Exit code: ${code}`),
              });
            }
          },
          (err) => {
            // Process spawn error - retryable
            resolve({ success: false, error: err });
          },
        );
      });
    };

    // Interruptible sleep that respects abort signal
    const interruptibleSleep = (ms) => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);
        abortController.signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
        });
      });
    };

    const runWithRetry = async () => {
      try {
        while (attempt < RETRY_MAX_ATTEMPTS) {
          // Check if aborted before each attempt
          if (abortController.signal.aborted) {
            console.log(`[${sessionId}] Retry aborted`);
            return;
          }

          attempt++;

          if (attempt > 1) {
            const delay = getRetryDelay(attempt - 2);
            console.log(
              `[${sessionId}] Retry attempt ${attempt}/${RETRY_MAX_ATTEMPTS} in ${Math.round(delay)}ms`,
            );
            socket.emit("retry-status", {
              attempt,
              maxAttempts: RETRY_MAX_ATTEMPTS,
              delayMs: Math.round(delay),
            });

            try {
              await interruptibleSleep(delay);
            } catch (e) {
              // Sleep was interrupted (user stopped or new message)
              console.log(`[${sessionId}] Retry sleep interrupted`);
              return;
            }
          }

          const result = await attemptCommand();

          if (result.success) {
            // Success - send response-end and push notification
            socket.emit("response-end", { exitCode: result.code });
            console.log(
              `[${sessionId}] Response complete (exit: ${result.code})`,
            );

            // Send push notification if client is backgrounded
            const isVisible = clientVisibility.get(sessionId);
            const subscription = pushSubscriptions.get(sessionId);

            const isValidSubscription =
              subscription?.endpoint &&
              typeof subscription.endpoint === "string" &&
              subscription.keys?.p256dh &&
              subscription.keys?.auth;

            if (
              !isVisible &&
              isValidSubscription &&
              process.env.VAPID_PUBLIC_KEY
            ) {
              try {
                await webpush.sendNotification(
                  subscription,
                  JSON.stringify({
                    title: "Claude Web",
                    body: "Response complete",
                    sessionId: sessionId,
                    url: "/",
                  }),
                );
                console.log(`[${sessionId}] Push notification sent`);
              } catch (err) {
                console.error(
                  `[${sessionId}] Push notification failed:`,
                  err.message,
                );
                if (err.statusCode >= 400 && err.statusCode < 500) {
                  pushSubscriptions.delete(sessionId);
                }
              }
            }
            return;
          }

          lastError = result.error;
          console.error(
            `[${sessionId}] Attempt ${attempt} failed: ${lastError.message}`,
          );
        }

        // All retries exhausted
        console.error(
          `[${sessionId}] All ${RETRY_MAX_ATTEMPTS} attempts failed`,
        );
        socket.emit("error", {
          message: `Request failed after ${RETRY_MAX_ATTEMPTS} attempts: ${lastError?.message || "Unknown error"}`,
          retryExhausted: true,
        });
      } finally {
        // Clean up abort controller
        activeRetries.delete(sessionId);
      }
    };

    runWithRetry();
  });

  socket.on("list-files", async (data) => {
    try {
      const requestedPath = expandPath(data?.path || HOME);
      const resolvedPath = resolve(requestedPath);

      // Security: ensure path is within allowed directories
      if (!resolvedPath.startsWith(HOME) && !resolvedPath.startsWith("/tmp")) {
        socket.emit("file-list", {
          files: [],
          path: resolvedPath,
          error: "Access denied",
        });
        return;
      }

      const entries = await readdir(resolvedPath, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => !entry.name.startsWith(".")) // Hide hidden files
          .slice(0, 50) // Limit to 50 entries
          .map(async (entry) => {
            const fullPath = join(resolvedPath, entry.name);
            return {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
            };
          }),
      );

      // Sort: directories first, then alphabetically
      files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      socket.emit("file-list", { files, path: resolvedPath });
    } catch (err) {
      socket.emit("file-list", {
        files: [],
        path: data?.path || HOME,
        error: err.message,
      });
    }
  });

  socket.on("stop", () => {
    if (sessionId) {
      // Abort any active retry operation
      if (activeRetries.has(sessionId)) {
        activeRetries.get(sessionId).abort();
        activeRetries.delete(sessionId);
      }
      stopSession(sessionId);
      socket.emit("stopped");
    }
  });

  // Conversation history handlers
  socket.on("save-conversation", async (data) => {
    try {
      const { id, title, messages, tokens, workingDir } = data;
      const isNew = !id;
      // Generate safe ID if not provided, validate if provided
      const safeId = id ? (isValidId(id) ? id : null) : Date.now().toString();
      if (!safeId) {
        socket.emit("error", { message: "Invalid conversation ID" });
        return;
      }
      const conversation = {
        id: safeId,
        title: title || generateTitle(messages),
        messages,
        tokens,
        workingDir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const filePath = join(HISTORY_DIR, `${conversation.id}.json`);
      await writeFile(filePath, JSON.stringify(conversation, null, 2));

      // Auto-link new conversations to active project
      if (isNew) {
        try {
          const activeId = getActiveProjectId();
          if (activeId) {
            linkConversation(safeId, activeId);
          }
        } catch (e) {
          console.error("Failed to auto-link conversation:", e.message);
        }
      }

      socket.emit("conversation-saved", {
        id: conversation.id,
        title: conversation.title,
      });
    } catch (err) {
      socket.emit("error", { message: `Failed to save: ${err.message}` });
    }
  });

  socket.on("list-conversations", async () => {
    try {
      const files = await readdir(HISTORY_DIR);
      const conversations = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = await readFile(join(HISTORY_DIR, file), "utf-8");
          const conv = JSON.parse(content);
          conversations.push({
            id: conv.id,
            title: conv.title,
            messageCount: conv.messages?.length || 0,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
          });
        } catch (e) {
          // Skip invalid files
        }
      }

      // Sort by most recent first
      conversations.sort(
        (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      );

      // Include all conversation links
      const links = getAllConversationLinks();

      socket.emit("conversations-list", { conversations, links });
    } catch (err) {
      socket.emit("conversations-list", { conversations: [], links: [] });
    }
  });

  socket.on("load-conversation", async (data) => {
    try {
      // Validate ID to prevent path traversal
      if (!isValidId(data?.id)) {
        socket.emit("error", { message: "Invalid conversation ID" });
        return;
      }
      const filePath = join(HISTORY_DIR, `${data.id}.json`);
      const content = await readFile(filePath, "utf-8");
      const conversation = JSON.parse(content);
      socket.emit("conversation-loaded", conversation);
    } catch (err) {
      socket.emit("error", { message: `Failed to load: ${err.message}` });
    }
  });

  socket.on("delete-conversation", async (data) => {
    try {
      // Validate ID to prevent path traversal
      if (!isValidId(data?.id)) {
        socket.emit("error", { message: "Invalid conversation ID" });
        return;
      }
      const filePath = join(HISTORY_DIR, `${data.id}.json`);
      await unlink(filePath);
      socket.emit("conversation-deleted", { id: data.id });
    } catch (err) {
      socket.emit("error", { message: `Failed to delete: ${err.message}` });
    }
  });

  // ===============================
  // Memory (MCP) handlers - MVP read-only
  // ===============================

  socket.on("memory-read-graph", async (data) => {
    try {
      const forceRefresh = data?.forceRefresh === true;
      console.log(
        `[${sessionId || socket.id}] Memory: read graph (refresh: ${forceRefresh})`,
      );
      const graph = await readGraph(forceRefresh);
      socket.emit("memory-graph", graph);
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Memory read error:`,
        err.message,
      );
      socket.emit("memory-error", {
        operation: "read-graph",
        message: err.message,
      });
    }
  });

  socket.on("memory-search", async (data) => {
    try {
      const query = data?.query;
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        socket.emit("memory-search-results", { entities: [], query: "" });
        return;
      }
      console.log(`[${sessionId || socket.id}] Memory: search "${query}"`);
      const results = await searchNodes(query);
      socket.emit("memory-search-results", { ...results, query });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Memory search error:`,
        err.message,
      );
      socket.emit("memory-error", {
        operation: "search",
        message: err.message,
      });
    }
  });

  socket.on("memory-get-entity", async (data) => {
    try {
      const name = data?.name;
      if (!name || typeof name !== "string") {
        socket.emit("memory-error", {
          operation: "get-entity",
          message: "Entity name required",
        });
        return;
      }
      console.log(`[${sessionId || socket.id}] Memory: get entity "${name}"`);
      const entity = await getEntity(name);
      socket.emit("memory-entity", { entity, name });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Memory get entity error:`,
        err.message,
      );
      socket.emit("memory-error", {
        operation: "get-entity",
        message: err.message,
      });
    }
  });

  // ============================================
  // Browser Preview (Puppeteer) Events
  // ============================================

  socket.on("browser-navigate", async (data) => {
    try {
      const url = data?.url;
      if (!url || typeof url !== "string") {
        socket.emit("browser-error", { message: "URL required" });
        return;
      }
      console.log(`[${sessionId || socket.id}] Browser: navigate to "${url}"`);
      const result = await puppeteerService.navigate(url);
      socket.emit("browser-navigated", result);
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Browser navigate error:`,
        err.message,
      );
      socket.emit("browser-error", { message: err.message });
    }
  });

  socket.on("browser-screenshot", async (data) => {
    try {
      // Validate and clamp viewport dimensions
      const MAX_WIDTH = 3840;
      const MAX_HEIGHT = 2160;
      const MIN_SIZE = 100;

      let width = parseInt(data?.width) || 1280;
      let height = parseInt(data?.height) || 800;

      // Clamp to reasonable bounds
      width = Math.max(MIN_SIZE, Math.min(MAX_WIDTH, width));
      height = Math.max(MIN_SIZE, Math.min(MAX_HEIGHT, height));

      const options = {
        width,
        height,
        name: `screenshot_${Date.now()}`,
      };
      console.log(
        `[${sessionId || socket.id}] Browser: screenshot (${options.width}x${options.height})`,
      );
      const result = await puppeteerService.takeScreenshot(options);
      socket.emit("browser-screenshot-ready", result);
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Browser screenshot error:`,
        err.message,
      );
      socket.emit("browser-error", { message: err.message });
    }
  });

  socket.on("browser-click", async (data) => {
    try {
      if (data?.x !== undefined && data?.y !== undefined) {
        // Coordinate-based click
        console.log(
          `[${sessionId || socket.id}] Browser: click at (${data.x}, ${data.y})`,
        );
        const result = await puppeteerService.clickAt(data.x, data.y);
        socket.emit("browser-clicked", result);
      } else if (data?.selector) {
        // Selector-based click
        console.log(
          `[${sessionId || socket.id}] Browser: click "${data.selector}"`,
        );
        const result = await puppeteerService.click(data.selector);
        socket.emit("browser-clicked", result);
      } else {
        socket.emit("browser-error", {
          message: "Selector or coordinates required",
        });
      }
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Browser click error:`,
        err.message,
      );
      socket.emit("browser-error", { message: err.message });
    }
  });

  socket.on("browser-evaluate", async (data) => {
    try {
      const script = data?.script;
      if (!script || typeof script !== "string") {
        socket.emit("browser-error", { message: "Script required" });
        return;
      }
      console.log(
        `[${sessionId || socket.id}] Browser: evaluate "${script.substring(0, 50)}..."`,
      );
      const result = await puppeteerService.evaluate(script);
      socket.emit("browser-evaluated", result);
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Browser evaluate error:`,
        err.message,
      );
      socket.emit("browser-error", { message: err.message });
    }
  });

  socket.on("browser-fill", async (data) => {
    try {
      const { selector, value } = data || {};
      if (!selector || typeof selector !== "string") {
        socket.emit("browser-error", { message: "Selector required" });
        return;
      }
      console.log(
        `[${sessionId || socket.id}] Browser: fill "${selector}" with "${(value || "").substring(0, 20)}..."`,
      );
      const result = await puppeteerService.fill(selector, value);
      socket.emit("browser-filled", result);
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Browser fill error:`,
        err.message,
      );
      socket.emit("browser-error", { message: err.message });
    }
  });

  // ============================================
  // Project Management Events
  // ============================================

  socket.on("project-list", () => {
    try {
      const projects = listProjects();
      const activeId = getActiveProjectId();
      socket.emit("project-list", { projects, activeId });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Project list error:`,
        err.message,
      );
      socket.emit("project-error", { operation: "list", message: err.message });
    }
  });

  socket.on("project-get", (data) => {
    try {
      if (!data?.id || !isValidUUID(data.id)) {
        socket.emit("project-error", {
          operation: "get",
          message: "Valid project ID required",
        });
        return;
      }
      const project = getProject(data.id);
      if (!project) {
        socket.emit("project-error", {
          operation: "get",
          message: "Project not found",
        });
        return;
      }
      socket.emit("project-data", { project });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Project get error:`,
        err.message,
      );
      socket.emit("project-error", { operation: "get", message: err.message });
    }
  });

  socket.on("project-create", (data) => {
    try {
      const { name, workingDir, model, contextFiles } = data || {};
      if (!name || !workingDir) {
        socket.emit("project-error", {
          operation: "create",
          message: "Name and working directory required",
        });
        return;
      }
      // Validate name length
      if (name.length > 255) {
        socket.emit("project-error", {
          operation: "create",
          message: "Project name too long (max 255 characters)",
        });
        return;
      }
      // Validate model against allowlist
      const validModels = ["opus", "sonnet", "haiku"];
      const safeModel = validModels.includes(model) ? model : "opus";
      // Validate working directory path
      const expandedDir = expandPath(workingDir);
      const resolvedDir = resolve(expandedDir);
      if (!resolvedDir.startsWith(HOME) && !resolvedDir.startsWith("/tmp")) {
        socket.emit("project-error", {
          operation: "create",
          message: "Working directory must be within home or /tmp",
        });
        return;
      }
      // Validate context files paths (if provided)
      const safeContextFiles = [];
      if (Array.isArray(contextFiles)) {
        for (const file of contextFiles.slice(0, 20)) {
          // Max 20 files
          if (typeof file !== "string" || file.length > 500) continue;
          // Resolve relative to project dir or absolute
          const expandedFile = expandPath(file);
          const resolvedFile = file.startsWith("/")
            ? resolve(expandedFile)
            : resolve(resolvedDir, expandedFile);
          if (
            resolvedFile.startsWith(HOME) ||
            resolvedFile.startsWith("/tmp")
          ) {
            safeContextFiles.push(file); // Store original user path
          }
        }
      }
      const project = createProject({
        name,
        workingDir: resolvedDir,
        model: safeModel,
        contextFiles: safeContextFiles,
      });
      console.log(
        `[${sessionId || socket.id}] Project created: ${project.name}`,
      );
      socket.emit("project-created", { project });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Project create error:`,
        err.message,
      );
      socket.emit("project-error", {
        operation: "create",
        message: err.message,
      });
    }
  });

  socket.on("project-update", (data) => {
    try {
      const { id, name, workingDir, model, contextFiles, ...otherUpdates } =
        data || {};
      if (!id || !isValidUUID(id)) {
        socket.emit("project-error", {
          operation: "update",
          message: "Valid project ID required",
        });
        return;
      }
      // Build safe updates object
      const safeUpdates = {};
      if (name !== undefined) {
        if (
          typeof name !== "string" ||
          name.length > 255 ||
          name.length === 0
        ) {
          socket.emit("project-error", {
            operation: "update",
            message: "Invalid project name",
          });
          return;
        }
        safeUpdates.name = name;
      }
      if (workingDir !== undefined) {
        const expandedDir = expandPath(workingDir);
        const resolvedDir = resolve(expandedDir);
        if (!resolvedDir.startsWith(HOME) && !resolvedDir.startsWith("/tmp")) {
          socket.emit("project-error", {
            operation: "update",
            message: "Working directory must be within home or /tmp",
          });
          return;
        }
        safeUpdates.workingDir = resolvedDir;
      }
      if (model !== undefined) {
        const validModels = ["opus", "sonnet", "haiku"];
        safeUpdates.model = validModels.includes(model) ? model : "opus";
      }
      if (contextFiles !== undefined && Array.isArray(contextFiles)) {
        const existing = getProject(id);
        const projectDir =
          existing?.workingDir || safeUpdates.workingDir || HOME;
        const safeContextFiles = [];
        for (const file of contextFiles.slice(0, 20)) {
          if (typeof file !== "string" || file.length > 500) continue;
          const expandedFile = expandPath(file);
          const resolvedFile = file.startsWith("/")
            ? resolve(expandedFile)
            : resolve(projectDir, expandedFile);
          if (
            resolvedFile.startsWith(HOME) ||
            resolvedFile.startsWith("/tmp")
          ) {
            safeContextFiles.push(file);
          }
        }
        safeUpdates.contextFiles = safeContextFiles;
      }
      const project = updateProject(id, safeUpdates);
      if (!project) {
        socket.emit("project-error", {
          operation: "update",
          message: "Project not found",
        });
        return;
      }
      console.log(
        `[${sessionId || socket.id}] Project updated: ${project.name}`,
      );
      socket.emit("project-updated", { project });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Project update error:`,
        err.message,
      );
      socket.emit("project-error", {
        operation: "update",
        message: err.message,
      });
    }
  });

  socket.on("project-delete", (data) => {
    try {
      if (!data?.id || !isValidUUID(data.id)) {
        socket.emit("project-error", {
          operation: "delete",
          message: "Valid project ID required",
        });
        return;
      }
      // Clear active project if deleting active one
      const activeId = getActiveProjectId();
      if (activeId === data.id) {
        setActiveProjectId(null);
      }
      const deleted = deleteProject(data.id);
      if (!deleted) {
        socket.emit("project-error", {
          operation: "delete",
          message: "Project not found",
        });
        return;
      }
      console.log(`[${sessionId || socket.id}] Project deleted: ${data.id}`);
      socket.emit("project-deleted", { id: data.id });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Project delete error:`,
        err.message,
      );
      socket.emit("project-error", {
        operation: "delete",
        message: err.message,
      });
    }
  });

  socket.on("project-activate", (data) => {
    try {
      const projectId = data?.id || null; // null to deactivate
      if (projectId) {
        const project = getProject(projectId);
        if (!project) {
          socket.emit("project-error", {
            operation: "activate",
            message: "Project not found",
          });
          return;
        }
      }
      setActiveProjectId(projectId);
      const activeProject = projectId ? getProject(projectId) : null;
      console.log(
        `[${sessionId || socket.id}] Active project: ${activeProject?.name || "none"}`,
      );
      socket.emit("project-activated", { project: activeProject });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Project activate error:`,
        err.message,
      );
      socket.emit("project-error", {
        operation: "activate",
        message: err.message,
      });
    }
  });

  socket.on("project-get-active", () => {
    try {
      const project = getActiveProject();
      socket.emit("project-active", { project });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Get active project error:`,
        err.message,
      );
      socket.emit("project-error", {
        operation: "get-active",
        message: err.message,
      });
    }
  });

  // ============================================
  // Task Management Events
  // ============================================

  socket.on("task-list", (data) => {
    try {
      if (!data?.projectId) {
        socket.emit("task-error", {
          operation: "list",
          message: "Project ID required",
        });
        return;
      }
      const tasks = listTasks(data.projectId, { status: data.status });
      socket.emit("task-list", { tasks, projectId: data.projectId });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Task list error:`,
        err.message,
      );
      socket.emit("task-error", { operation: "list", message: err.message });
    }
  });

  socket.on("task-create", (data) => {
    try {
      const { projectId, title, description, priority } = data || {};
      if (!projectId || !title) {
        socket.emit("task-error", {
          operation: "create",
          message: "Project ID and title required",
        });
        return;
      }
      const task = createTask({ projectId, title, description, priority });
      console.log(`[${sessionId || socket.id}] Task created: ${task.title}`);
      socket.emit("task-created", { task });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Task create error:`,
        err.message,
      );
      socket.emit("task-error", { operation: "create", message: err.message });
    }
  });

  socket.on("task-update", (data) => {
    try {
      const { id, ...updates } = data || {};
      if (!id) {
        socket.emit("task-error", {
          operation: "update",
          message: "Task ID required",
        });
        return;
      }
      const task = updateTask(id, updates);
      if (!task) {
        socket.emit("task-error", {
          operation: "update",
          message: "Task not found",
        });
        return;
      }
      console.log(
        `[${sessionId || socket.id}] Task updated: ${task.title} (${task.status})`,
      );
      socket.emit("task-updated", { task });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Task update error:`,
        err.message,
      );
      socket.emit("task-error", { operation: "update", message: err.message });
    }
  });

  socket.on("task-delete", (data) => {
    try {
      if (!data?.id) {
        socket.emit("task-error", {
          operation: "delete",
          message: "Task ID required",
        });
        return;
      }
      const deleted = deleteTask(data.id);
      if (!deleted) {
        socket.emit("task-error", {
          operation: "delete",
          message: "Task not found",
        });
        return;
      }
      console.log(`[${sessionId || socket.id}] Task deleted: ${data.id}`);
      socket.emit("task-deleted", { id: data.id });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Task delete error:`,
        err.message,
      );
      socket.emit("task-error", { operation: "delete", message: err.message });
    }
  });

  // ============================================
  // Folder Management Events
  // ============================================

  socket.on("folder-list", (data) => {
    try {
      if (!data?.projectId) {
        socket.emit("folder-error", {
          operation: "list",
          message: "Project ID required",
        });
        return;
      }
      const folders = listFolders(data.projectId);
      socket.emit("folder-list", { folders, projectId: data.projectId });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Folder list error:`,
        err.message,
      );
      socket.emit("folder-error", { operation: "list", message: err.message });
    }
  });

  socket.on("folder-create", (data) => {
    try {
      const { projectId, name } = data || {};
      if (!projectId || !name) {
        socket.emit("folder-error", {
          operation: "create",
          message: "Project ID and name required",
        });
        return;
      }
      const folder = createFolder({ projectId, name });
      console.log(`[${sessionId || socket.id}] Folder created: ${folder.name}`);
      socket.emit("folder-created", { folder });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Folder create error:`,
        err.message,
      );
      socket.emit("folder-error", {
        operation: "create",
        message: err.message,
      });
    }
  });

  socket.on("folder-update", (data) => {
    try {
      const { id, ...updates } = data || {};
      if (!id) {
        socket.emit("folder-error", {
          operation: "update",
          message: "Folder ID required",
        });
        return;
      }
      const folder = updateFolder(id, updates);
      if (!folder) {
        socket.emit("folder-error", {
          operation: "update",
          message: "Folder not found",
        });
        return;
      }
      console.log(`[${sessionId || socket.id}] Folder updated: ${folder.name}`);
      socket.emit("folder-updated", { folder });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Folder update error:`,
        err.message,
      );
      socket.emit("folder-error", {
        operation: "update",
        message: err.message,
      });
    }
  });

  socket.on("folder-delete", (data) => {
    try {
      if (!data?.id) {
        socket.emit("folder-error", {
          operation: "delete",
          message: "Folder ID required",
        });
        return;
      }
      const deleted = deleteFolder(data.id);
      if (!deleted) {
        socket.emit("folder-error", {
          operation: "delete",
          message: "Folder not found",
        });
        return;
      }
      console.log(`[${sessionId || socket.id}] Folder deleted: ${data.id}`);
      socket.emit("folder-deleted", { id: data.id });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Folder delete error:`,
        err.message,
      );
      socket.emit("folder-error", {
        operation: "delete",
        message: err.message,
      });
    }
  });

  // ============================================
  // Conversation Link Events
  // ============================================

  socket.on("conversation-link", (data) => {
    try {
      const { conversationId, projectId, folderId } = data || {};
      if (!conversationId || !projectId) {
        socket.emit("conversation-link-error", {
          message: "Conversation ID and Project ID required",
        });
        return;
      }
      const link = linkConversation(conversationId, projectId, folderId);
      console.log(
        `[${sessionId || socket.id}] Conversation linked: ${conversationId} -> ${projectId}`,
      );
      socket.emit("conversation-linked", { link });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Conversation link error:`,
        err.message,
      );
      socket.emit("conversation-link-error", { message: err.message });
    }
  });

  socket.on("conversation-unlink", (data) => {
    try {
      const { conversationId } = data || {};
      if (!conversationId) {
        socket.emit("conversation-link-error", {
          message: "Conversation ID required",
        });
        return;
      }
      const unlinked = unlinkConversation(conversationId);
      if (unlinked) {
        console.log(
          `[${sessionId || socket.id}] Conversation unlinked: ${conversationId}`,
        );
        socket.emit("conversation-unlinked", { conversationId });
      } else {
        socket.emit("conversation-link-error", {
          message: "Conversation not linked",
        });
      }
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Conversation unlink error:`,
        err.message,
      );
      socket.emit("conversation-link-error", { message: err.message });
    }
  });

  socket.on("conversation-get-link", (data) => {
    try {
      if (!data?.conversationId) {
        socket.emit("conversation-link-error", {
          message: "Conversation ID required",
        });
        return;
      }
      const link = getConversationLink(data.conversationId);
      socket.emit("conversation-link-data", {
        link,
        conversationId: data.conversationId,
      });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Get conversation link error:`,
        err.message,
      );
      socket.emit("conversation-link-error", { message: err.message });
    }
  });

  socket.on("conversation-move-to-folder", (data) => {
    try {
      const { conversationId, folderId } = data || {};
      if (!conversationId) {
        socket.emit("conversation-link-error", {
          message: "Conversation ID required",
        });
        return;
      }
      const moved = moveConversationToFolder(conversationId, folderId);
      if (!moved) {
        socket.emit("conversation-link-error", {
          message: "Conversation not linked to any project",
        });
        return;
      }
      console.log(
        `[${sessionId || socket.id}] Conversation moved to folder: ${conversationId} -> ${folderId || "root"}`,
      );
      socket.emit("conversation-moved", { conversationId, folderId });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] Move conversation error:`,
        err.message,
      );
      socket.emit("conversation-link-error", { message: err.message });
    }
  });

  socket.on("conversation-list-by-project", (data) => {
    try {
      if (!data?.projectId) {
        socket.emit("conversation-link-error", {
          message: "Project ID required",
        });
        return;
      }
      const links = listConversationLinks(data.projectId, data.folderId);
      socket.emit("conversation-links-list", {
        links,
        projectId: data.projectId,
        folderId: data.folderId,
      });
    } catch (err) {
      console.error(
        `[${sessionId || socket.id}] List conversations by project error:`,
        err.message,
      );
      socket.emit("conversation-link-error", { message: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Clean up rate limiter for this socket
    rateLimiter.cleanup(socket.id);
    // Note: We intentionally DO NOT delete push subscription or visibility on disconnect
    // These are stored per session and should persist so push notifications work
    // even after the phone disconnects (e.g., screen off kills the socket)
    // Note: We no longer stop the session on disconnect to enable persistence
    // The session remains available for reconnection
    if (sessionId) {
      console.log(`Session ${sessionId} preserved for reconnection`);
    }
  });
});

// Load persisted sessions and start server
(async () => {
  // Initialize SQLite database
  await initDatabase();
  console.log("Database initialized");

  await loadPersistedSessions();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Claude Web running on http://0.0.0.0:${PORT}`);
    console.log(
      `Auth token required: ${process.env.AUTH_TOKEN?.substring(0, 8)}...`,
    );
    console.log(
      `Rate limit: ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
    );
  });
})();
