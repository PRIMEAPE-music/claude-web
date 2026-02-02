// Elements
const authScreen = document.getElementById("auth-screen");
const chatScreen = document.getElementById("chat-screen");
const tokenInput = document.getElementById("token-input");
const authBtn = document.getElementById("auth-btn");
const authError = document.getElementById("auth-error");
const status = document.getElementById("status");
const messages = document.getElementById("messages");
const promptInput = document.getElementById("prompt");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const voiceBtn = document.getElementById("voice-btn");
const menuBtn = document.getElementById("menu-btn");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const closeSidebarBtn = document.getElementById("close-sidebar");
const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const closeSettingsBtn = document.getElementById("close-settings");
const workingDirDisplay = document.getElementById("working-dir");
const dirInput = document.getElementById("dir-input");
const dirSetBtn = document.getElementById("dir-set-btn");
const welcomeMessage = document.getElementById("welcome-message");
const notificationSound = document.getElementById("notification-sound");
notificationSound.volume = 0.1; // 90% quieter
const uploadBtn = document.getElementById("upload-btn");
const fileUpload = document.getElementById("file-upload");
const imagePreviewArea = document.getElementById("image-preview-area");
const imageLightbox = document.getElementById("image-lightbox");
const lightboxImage = document.getElementById("lightbox-image");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxDownload = document.getElementById("lightbox-download");

// State
let socket = null;
let currentResponse = null;
let isStreaming = false;
let workingDir = localStorage.getItem("claude-web-workingDir") || "~";
let recognition = null;

// Streaming state
let pendingText = "";
let renderTimeout = null;
let elapsedInterval = null;
let responseStartTime = null;
let sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let currentToolContainer = null; // Groups all tools for current response
let toolCount = 0;
let currentResponseStats = null; // Store stats for adding badge after final render
const RENDER_DEBOUNCE_MS = 50; // Balance between responsiveness and performance

// Conversation state
let currentConversationId = localStorage.getItem("claude-web-conversationId");
let conversationMessages = [];

// Session persistence state
let currentSessionId = localStorage.getItem("claude-web-sessionId");
let isRecoveringFromFailedRestore = false; // Flag to preserve conversation on session fallback
let pendingBufferedResponseAfterLoad = false; // Flag to chain buffered-response after conversation load

// Conversation list state
let conversationsCache = [];
let conversationLinksCache = {}; // Map of conversationId -> { projectId, folderId }
let historyProjectFilter = ""; // Current filter by project ID

// Project state (declared early to avoid TDZ issues on mobile browsers)
let projectsCache = [];
let activeProjectId = null;

// History filter element
const historyProjectFilterSelect = document.getElementById(
  "history-project-filter",
);

// Image upload state
let pendingImages = []; // Array of { file, dataUrl, path }
let uploadedImagePaths = []; // Paths returned from server after upload
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
const MAX_IMAGES_PER_MESSAGE = 5;

// Settings
const settings = {
  theme: localStorage.getItem("theme") || "dark",
  fontSize: parseInt(localStorage.getItem("fontSize")) || 16,
  soundEnabled: localStorage.getItem("soundEnabled") !== "false",
  autoScroll: localStorage.getItem("autoScroll") !== "false",
  showTools: localStorage.getItem("showTools") !== "false",
  vibrateEnabled: localStorage.getItem("vibrateEnabled") !== "false",
  pushEnabled: localStorage.getItem("pushEnabled") !== "false",
  model: localStorage.getItem("claude-model") || "opus",
};

// Push notification state
let swRegistration = null;
let pushSubscription = null;
let isPageVisible = !document.hidden;

// VAPID public key (must match server)
const VAPID_PUBLIC_KEY =
  "BAWszWNbFyGFZ8BEHJ0Zn3mojgzgDVP_nG1fwOsfi23ERjFg6uXUmCQ_bPuwth_MlZ9fF4r_9KOwxy5hpyHJ2PA";

// Track page visibility
let lastVisibilityChangeTime = Date.now();

document.addEventListener("visibilitychange", () => {
  isPageVisible = !document.hidden;
  lastVisibilityChangeTime = Date.now();
  // Notify server of visibility change
  if (socket?.connected) {
    socket.emit("visibility-change", { visible: isPageVisible });
  }
});

// Register service worker and setup push notifications
async function setupPushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.log("Push notifications not supported in this browser");
    return;
  }

  try {
    // Register service worker
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    console.log("Service worker registered");

    // Wait for service worker to be ready
    await navigator.serviceWorker.ready;
    console.log("Service worker ready");

    // Check existing subscription
    pushSubscription = await swRegistration.pushManager.getSubscription();

    if (pushSubscription) {
      console.log("Existing push subscription found");
    } else {
      console.log("No push subscription - user can enable in settings");
      // Don't auto-request permission - Firefox blocks this without user interaction
      // User must explicitly enable in settings
    }
  } catch (err) {
    console.error("Failed to setup push notifications:", err);
  }
}

// Subscribe to push notifications
// Returns true on success, false on failure
async function subscribeToPush() {
  if (!swRegistration) {
    console.error("Push failed: Service worker not registered");
    showToast("Error: Service worker not ready");
    return false;
  }

  try {
    // Request notification permission
    console.log("Requesting notification permission...");
    const permission = await Notification.requestPermission();
    console.log("Permission result:", permission);

    if (permission !== "granted") {
      console.log("Notification permission denied or blocked");
      showToast("Notification permission denied");
      return false;
    }

    // Convert VAPID key to Uint8Array
    const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    console.log("Subscribing to push manager...");

    // Subscribe to push
    pushSubscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });

    console.log("Push subscription created successfully");
    return true;
  } catch (err) {
    console.error("Failed to subscribe to push:", err);
    showToast("Push error: " + err.message);
    return false;
  }
}

// Helper to convert base64 VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Check if a push notification was already shown for this response
async function wasNotifiedByPush(sessionId) {
  if (!navigator.serviceWorker?.controller) return false;

  return new Promise((resolve) => {
    const messageHandler = (event) => {
      if (
        event.data?.type === "NOTIFICATION_FLAG_RESULT" &&
        event.data?.sessionId === sessionId
      ) {
        navigator.serviceWorker.removeEventListener("message", messageHandler);
        resolve(event.data.wasNotified);
      }
    };

    navigator.serviceWorker.addEventListener("message", messageHandler);
    navigator.serviceWorker.controller.postMessage({
      type: "CHECK_NOTIFICATION_FLAG",
      sessionId,
    });

    // Timeout after 500ms
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", messageHandler);
      resolve(false);
    }, 500);
  });
}

// Clear push notification flag after handling
function clearPushNotificationFlag(sessionId) {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "CLEAR_NOTIFICATION_FLAG",
      sessionId,
    });
  }
}

// Listen for service worker messages
// Note: We intentionally don't play sound on PLAY_NOTIFICATION_SOUND message
// because push notifications use system sound, and playing Mario sound
// when hidden would cause double-play issues when user returns to app
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    // Handle other SW messages if needed in the future
    if (event.data?.type === "NOTIFICATION_FLAG_RESULT") {
      // Handled by wasNotifiedByPush() promise
    }
  });
}

// Initialize push notifications on page load
setupPushNotifications();

// Apply initial settings
applySettings();

// Configure marked for markdown
marked.setOptions({
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true,
});

// Check for saved token
const savedToken = localStorage.getItem("claude-web-token");
if (savedToken) {
  tokenInput.value = savedToken;
  connect(savedToken);
}

// Auth handlers
authBtn.onclick = () => {
  const token = tokenInput.value.trim();
  if (token) connect(token);
};

tokenInput.onkeydown = (e) => {
  if (e.key === "Enter") authBtn.click();
};

function connect(token) {
  authError.textContent = "";
  authBtn.disabled = true;
  authBtn.textContent = "Connecting...";

  socket = io({ auth: { token } });

  socket.on("connect", () => {
    localStorage.setItem("claude-web-token", token);
    authScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    status.classList.add("connected");
    sendBtn.disabled = false;
    updateActionsBarState(); // Enable quick actions bar buttons

    // Try to restore previous session, or start a new one
    if (currentSessionId) {
      console.log("Attempting to restore session:", currentSessionId);
      socket.emit("restore-session", { sessionId: currentSessionId });
    } else {
      socket.emit("start-session", {
        workingDir: expandPath(workingDir),
        model: settings.model,
      });
    }
    updateWorkingDirDisplay();
    loadFileList(workingDir);

    // Setup memory socket listeners immediately on connect
    setupMemorySocketListeners();

    // Load active project on connect
    loadActiveProject();

    // Note: Push subscription and visibility are sent AFTER session is established
    // (in session-started and session-restored handlers) to ensure sessionId is set
  });

  socket.on("connect_error", (err) => {
    authBtn.disabled = false;
    authBtn.textContent = "Connect";
    if (err.message === "Unauthorized") {
      authError.textContent = "Invalid token";
      localStorage.removeItem("claude-web-token");
    } else {
      authError.textContent = "Connection failed: " + err.message;
    }
  });

  socket.on("disconnect", () => {
    // Clean up streaming state on disconnect
    clearTimeout(renderTimeout);
    clearInterval(elapsedInterval);
    pendingText = "";
    if (currentResponse) {
      currentResponse.classList.remove("streaming");
      const progress = currentResponse.querySelector(".progress-indicator");
      if (progress) progress.remove();
    }
    isStreaming = false;
    updateActionsBarState();
    currentResponse = null;

    status.classList.remove("connected");
    sendBtn.disabled = true;
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    showToast("Disconnected from server");
  });

  socket.on("session-started", (data) => {
    console.log("Session started:", data.sessionId);
    // Store session ID for persistence
    currentSessionId = data.sessionId;
    localStorage.setItem("claude-web-sessionId", currentSessionId);
    // Reset session state
    sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    // Check if we're recovering from a failed session restore
    if (isRecoveringFromFailedRestore) {
      isRecoveringFromFailedRestore = false;
      // Preserve conversation - load it from history
      if (currentConversationId) {
        socket.emit("load-conversation", { id: currentConversationId });
      }
    } else {
      // Fresh new session - clear conversation
      currentConversationId = null;
      localStorage.removeItem("claude-web-conversationId");
      conversationMessages = [];
    }

    // Send push subscription and visibility state now that session is established
    if (pushSubscription) {
      socket.emit("push-subscribe", {
        subscription: pushSubscription.toJSON(),
      });
    }
    socket.emit("visibility-change", { visible: isPageVisible });
    updateSessionTokenDisplay();
  });

  socket.on("session-restored", (data) => {
    console.log(
      "Session restored:",
      data.sessionId,
      `(${data.messageCount} messages)`,
    );
    currentSessionId = data.sessionId;
    localStorage.setItem("claude-web-sessionId", currentSessionId);
    showToast(`Session restored (${data.messageCount} messages)`);
    // Keep existing token state since we're resuming

    // Send push subscription and visibility state now that session is established
    if (pushSubscription) {
      socket.emit("push-subscribe", {
        subscription: pushSubscription.toJSON(),
      });
    }
    socket.emit("visibility-change", { visible: isPageVisible });

    // Restore conversation history from saved conversation
    // Note: We load conversation first, THEN check for buffered response
    // The buffered-response handler will append to the loaded conversation
    if (currentConversationId) {
      // Set flag so the normal conversation-loaded handler knows to chain buffered-response
      pendingBufferedResponseAfterLoad = true;
      socket.emit("load-conversation", { id: currentConversationId });
    } else {
      // No conversation to load, just check for buffered response
      socket.emit("get-buffered-response");
    }
  });

  // Handle buffered response (for when client reconnects after disconnect)
  socket.on("buffered-response", (data) => {
    if (!data.chunks || data.chunks.length === 0) return;

    console.log(
      `Received ${data.chunks.length} buffered chunks (complete: ${data.isComplete})`,
    );
    showToast(`Resuming response (${data.chunks.length} chunks)...`);

    // Reset tool container state for buffered response replay
    currentToolContainer = null;
    toolCount = 0;

    // Create or get the current response element
    if (!currentResponse) {
      currentResponse = addMessage("", "assistant");
    }

    // Replay all buffered chunks
    for (const chunk of data.chunks) {
      if (chunk.type === "text") {
        currentResponse.dataset.raw =
          (currentResponse.dataset.raw || "") + chunk.content;
      } else if (chunk.type === "tool_start" && settings.showTools) {
        addToolToContainer(
          chunk.name,
          JSON.stringify(chunk.input, null, 2),
          chunk.id,
        );
      } else if (
        chunk.type === "tool_result" &&
        settings.showTools &&
        currentToolContainer
      ) {
        const toolItem = currentToolContainer.querySelector(
          `.tool-item[data-tool-id="${chunk.id}"]`,
        );
        if (toolItem) {
          const content = toolItem.querySelector(".tool-content");
          if (content && chunk.output) {
            content.textContent = chunk.output;
          }
        }
      } else if (chunk.type === "stats") {
        const usage = chunk.usage || {};
        sessionTokens.input += usage.input_tokens || 0;
        sessionTokens.output += usage.output_tokens || 0;
        updateSessionTokenDisplay();
        // Store stats for adding badge after render
        currentResponseStats = { usage, duration: chunk.duration };
      }
    }

    // Render the markdown
    if (currentResponse) {
      renderMarkdown(currentResponse);
      if (settings.autoScroll) scrollToBottom();

      // Add token badge after render (so it doesn't get overwritten)
      if (currentResponseStats) {
        addTokenBadge(
          currentResponse,
          currentResponseStats.usage,
          currentResponseStats.duration,
        );
      }
    }

    // If response is complete, finalize it
    if (data.isComplete && currentResponse) {
      currentResponse.classList.remove("streaming");
      currentResponseStats = null;
      conversationMessages.push({
        type: "assistant",
        content: currentResponse.dataset.raw || "",
        timestamp: Date.now(),
      });
      autoSaveConversation();
      currentResponse = null;
      currentToolContainer = null;
      toolCount = 0;

      // Check if push notification already played the sound
      // Only play sound if NOT already notified by push (prevents double-play on mobile)
      (async () => {
        const alreadyNotified = await wasNotifiedByPush(currentSessionId);
        if (alreadyNotified) {
          console.log("Push notification already shown, skipping sound");
          clearPushNotificationFlag(currentSessionId);
        } else if (settings.soundEnabled) {
          notificationSound.play().catch(() => {});
        }
      })();
      showToast("Response complete");
    } else {
      // Still buffering - show that we're waiting
      currentResponse.classList.add("streaming");
      showToast("Response still in progress...");
    }
  });

  socket.on("session-restore-failed", (data) => {
    console.log("Session restore failed, starting new session");
    // Clear stale session ID but preserve conversation history
    currentSessionId = null;
    localStorage.removeItem("claude-web-sessionId");
    // Set flag to preserve conversation when session-started fires
    isRecoveringFromFailedRestore = true;
    socket.emit("start-session", {
      workingDir: expandPath(workingDir),
      model: settings.model,
    });
  });

  socket.on("rate-limited", (data) => {
    showToast(`⚠️ ${data.message}`);
    // Show countdown in UI
    let countdown = data.resetIn;
    sendBtn.disabled = true;
    sendBtn.textContent = `Wait ${countdown}s`;
    const interval = setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        clearInterval(interval);
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
      } else {
        sendBtn.textContent = `Wait ${countdown}s`;
      }
    }, 1000);
  });

  socket.on("response-start", () => {
    isStreaming = true;
    updateActionsBarState();
    pendingText = "";
    clearTimeout(renderTimeout);
    clearInterval(elapsedInterval);
    responseStartTime = Date.now();
    currentToolContainer = null; // Reset tool container for new response
    toolCount = 0;
    currentResponseStats = null; // Reset stats for new response
    sendBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    welcomeMessage?.remove();
    currentResponse = addMessage("", "assistant");
    currentResponse.classList.add("streaming");

    // Add progress indicator with elapsed time
    const progress = document.createElement("div");
    progress.className = "progress-indicator";
    progress.innerHTML = `
      <div class="progress-status">
        <span class="progress-dots"><span></span><span></span><span></span></span>
        <span class="progress-text">Thinking...</span>
      </div>
      <span class="progress-elapsed">0s</span>
    `;
    currentResponse.appendChild(progress);

    // Update elapsed time every second
    elapsedInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - responseStartTime) / 1000);
      const elapsedEl = currentResponse?.querySelector(".progress-elapsed");
      if (elapsedEl) {
        elapsedEl.textContent =
          elapsed < 60
            ? `${elapsed}s`
            : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
      }
    }, 1000);
  });

  socket.on("response-chunk", (chunk) => {
    if (!currentResponse) return;

    if (chunk.type === "text") {
      // Remove progress indicator when text arrives
      const progress = currentResponse.querySelector(".progress-indicator");
      if (progress) progress.remove();

      // Accumulate text chunks
      pendingText += chunk.content;

      // Debounce markdown rendering
      clearTimeout(renderTimeout);
      renderTimeout = setTimeout(() => {
        currentResponse.dataset.raw =
          (currentResponse.dataset.raw || "") + pendingText;
        pendingText = "";
        renderMarkdown(currentResponse);
        if (settings.autoScroll) scrollToBottom();
      }, RENDER_DEBOUNCE_MS);
    } else if (chunk.type === "result") {
      // Final result (fallback for non-streaming)
      const progress = currentResponse.querySelector(".progress-indicator");
      if (progress) progress.remove();
      clearTimeout(renderTimeout);
      currentResponse.dataset.raw =
        (currentResponse.dataset.raw || "") + pendingText + chunk.content;
      pendingText = "";
      renderMarkdown(currentResponse);
      if (settings.autoScroll) scrollToBottom();
    } else if (chunk.type === "tool_start") {
      // Update progress indicator with tool info
      updateProgressStatus(`Using ${chunk.name}...`);
      if (settings.showTools) {
        const inputStr =
          typeof chunk.input === "string"
            ? chunk.input
            : JSON.stringify(chunk.input, null, 2);
        addToolToContainer(chunk.name, inputStr || "(executing...)", chunk.id);
        if (settings.autoScroll) scrollToBottom();
      }
    } else if (chunk.type === "tool_result") {
      // Tool finished - update progress and tool message
      updateProgressStatus("Thinking...");
      if (settings.showTools && currentToolContainer) {
        // Find the tool item by ID within the container and update it
        const toolItem = currentToolContainer.querySelector(
          `.tool-item[data-tool-id="${chunk.id}"]`,
        );
        if (toolItem) {
          const content = toolItem.querySelector(".tool-content");
          const header = toolItem.querySelector(
            ".tool-item-header span:first-child",
          );
          if (content && chunk.output) {
            // Check if output contains an image
            const imageDataUrl = renderImageContent(chunk.output);
            if (imageDataUrl) {
              // Render as image
              content.innerHTML = "";
              const imgWrapper = document.createElement("div");
              imgWrapper.className = "tool-image-result";
              const img = document.createElement("img");
              img.src = imageDataUrl;
              img.alt = "Tool output image";
              img.onclick = () => openLightbox(imageDataUrl, "screenshot.png");
              imgWrapper.appendChild(img);
              content.appendChild(imgWrapper);
              // Auto-expand tool items with images
              toolItem.classList.add("expanded");
              header.querySelector("span:last-child").textContent = "▲";
            } else {
              content.textContent = chunk.output;
            }
          }
          if (header) {
            header.innerHTML = chunk.isError
              ? "❌ " + header.textContent.replace("🔧 ", "")
              : "✅ " + header.textContent.replace("🔧 ", "");
          }
        }
        // Update container header with completed count
        updateToolContainerHeader();
      }
    } else if (chunk.type === "tool" && settings.showTools) {
      addToolToContainer(chunk.name, chunk.input);
      if (settings.autoScroll) scrollToBottom();
    } else if (chunk.type === "stats") {
      // Update session tokens and store stats for badge (added after final render)
      const usage = chunk.usage || {};
      sessionTokens.input += usage.input_tokens || 0;
      sessionTokens.output += usage.output_tokens || 0;
      sessionTokens.cacheRead += usage.cache_read_input_tokens || 0;
      sessionTokens.cacheWrite += usage.cache_creation_input_tokens || 0;
      updateSessionTokenDisplay();
      updateContextDisplay(usage);
      // Store stats to add badge after final renderMarkdown in response-end
      currentResponseStats = { usage, duration: chunk.duration };
    } else if (chunk.type === "error") {
      const progress = currentResponse.querySelector(".progress-indicator");
      if (progress) progress.remove();
      addMessage(chunk.content, "error");
      if (settings.autoScroll) scrollToBottom();
    }
  });

  function updateProgressStatus(text) {
    if (!currentResponse) return;
    const statusText = currentResponse.querySelector(".progress-text");
    if (statusText) {
      statusText.textContent = text;
    }
  }

  socket.on("response-end", () => {
    // Clean up any active retry countdown
    clearRetryCountdown();
    // Flush any pending text
    clearTimeout(renderTimeout);
    clearInterval(elapsedInterval);
    if (pendingText && currentResponse) {
      currentResponse.dataset.raw =
        (currentResponse.dataset.raw || "") + pendingText;
      pendingText = "";
      try {
        renderMarkdown(currentResponse);
      } catch (e) {
        console.error("Markdown render failed:", e);
      }
    }

    // Track assistant message
    if (currentResponse) {
      const content = currentResponse.dataset.raw || "";
      if (content) {
        conversationMessages.push({
          type: "assistant",
          content,
          timestamp: Date.now(),
        });
        // Auto-save conversation
        autoSaveConversation();
      }
    }

    // Remove streaming class and progress indicator
    if (currentResponse) {
      currentResponse.classList.remove("streaming");
      const progress = currentResponse.querySelector(".progress-indicator");
      if (progress) progress.remove();

      // Add token badge after final render (stats arrive before response-end)
      if (currentResponseStats) {
        addTokenBadge(
          currentResponse,
          currentResponseStats.usage,
          currentResponseStats.duration,
        );
      }
    }

    isStreaming = false;
    updateActionsBarState();
    currentResponse = null;
    currentResponseStats = null; // Reset stats for next response
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");

    // Remove any remaining progress indicators
    document
      .querySelectorAll(".progress-indicator")
      .forEach((el) => el.remove());

    // Play sound and vibrate ONLY if page is visible AND was visible during response
    // Skip if page just became visible (within 1 second) - this handles queued events
    // that fire immediately when returning from minimized state
    const justBecameVisible = Date.now() - lastVisibilityChangeTime < 1000;
    const shouldPlaySound = isPageVisible && !justBecameVisible;

    if (shouldPlaySound) {
      if (settings.soundEnabled) {
        notificationSound.play().catch(() => {});
      }
      if (settings.vibrateEnabled && navigator.vibrate) {
        navigator.vibrate(50);
      }
    }
  });

  // Track retry countdown interval for cleanup
  let retryCountdownInterval = null;

  // Helper to clear retry countdown
  function clearRetryCountdown() {
    if (retryCountdownInterval) {
      clearInterval(retryCountdownInterval);
      retryCountdownInterval = null;
    }
  }

  // Handle retry status (exponential backoff)
  socket.on("retry-status", (data) => {
    const { attempt, maxAttempts, delayMs } = data;
    console.log(`Retry attempt ${attempt}/${maxAttempts} in ${delayMs}ms`);

    // Clear any existing countdown
    clearRetryCountdown();

    // Update progress indicator to show retry status
    if (currentResponse) {
      const statusText = currentResponse.querySelector(".progress-text");
      if (statusText) {
        // Show countdown
        let remaining = Math.ceil(delayMs / 1000);
        statusText.textContent = `Retrying in ${remaining}s (attempt ${attempt}/${maxAttempts})...`;
        statusText.style.color = "#ffa500"; // Orange for retry

        retryCountdownInterval = setInterval(() => {
          remaining--;
          if (remaining > 0) {
            statusText.textContent = `Retrying in ${remaining}s (attempt ${attempt}/${maxAttempts})...`;
          } else {
            statusText.textContent = `Retrying... (attempt ${attempt}/${maxAttempts})`;
            statusText.style.color = ""; // Reset color
            clearRetryCountdown();
          }
        }, 1000);
      }
    }

    showToast(`Request failed, retrying in ${Math.ceil(delayMs / 1000)}s...`);
  });

  socket.on("error", (data) => {
    clearRetryCountdown(); // Clean up any active countdown
    addMessage(`Error: ${data.message}`, "error");
    isStreaming = false;
    updateActionsBarState();
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");

    // Show extra feedback if retries were exhausted
    if (data.retryExhausted) {
      showToast("All retry attempts failed");
    }
  });

  socket.on("stopped", () => {
    // Clean up any active retry countdown
    clearRetryCountdown();
    // Flush pending text before adding stopped message
    if (pendingText && currentResponse) {
      currentResponse.dataset.raw =
        (currentResponse.dataset.raw || "") + pendingText;
      pendingText = "";
    }
    clearTimeout(renderTimeout);
    clearInterval(elapsedInterval);

    if (currentResponse) {
      const progress = currentResponse.querySelector(".progress-indicator");
      if (progress) progress.remove();
      currentResponse.dataset.raw =
        (currentResponse.dataset.raw || "") + "\n\n*[Response stopped]*";
      currentResponse.classList.remove("streaming");
      renderMarkdown(currentResponse);
    }
    isStreaming = false;
    updateActionsBarState();
    currentResponse = null;
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
  });

  socket.on("file-list", (data) => {
    renderFileList(data.files, data.path);
  });

  // Conversation history handlers
  socket.on("conversations-list", (data) => {
    conversationsCache = data.conversations || [];
    renderConversationList(conversationsCache);
  });

  socket.on("conversation-loaded", (conversation) => {
    loadConversation(conversation);
    // If we're restoring after session-restored, now fetch buffered response
    if (pendingBufferedResponseAfterLoad) {
      pendingBufferedResponseAfterLoad = false;
      socket.emit("get-buffered-response");
    }
  });

  socket.on("conversation-saved", (data) => {
    currentConversationId = data.id;
    localStorage.setItem("claude-web-conversationId", currentConversationId);
    showToast("Conversation saved");
    socket.emit("list-conversations");
  });

  socket.on("conversation-deleted", (data) => {
    showToast("Conversation deleted");
    socket.emit("list-conversations");
  });

  // Conversation linking events
  socket.on("conversation-linked", (data) => {
    if (data.link) {
      conversationLinksCache[data.link.conversationId] = {
        projectId: data.link.projectId,
        folderId: data.link.folderId,
      };
      renderConversationList(conversationsCache);
      showToast("Conversation linked to project");
    }
  });

  socket.on("conversation-unlinked", (data) => {
    if (data.conversationId) {
      delete conversationLinksCache[data.conversationId];
      renderConversationList(conversationsCache);
      showToast("Conversation unlinked");
    }
  });

  socket.on("conversation-link-error", (data) => {
    console.error("Conversation link error:", data);
    showToast(`Link error: ${data.message}`);
  });

  // Load conversation list on connect
  socket.emit("list-conversations");

  // Load projects for history filter (if not already loaded)
  if (projectsCache.length === 0) {
    socket.emit("project-list");
  }
}

// Message handlers
sendBtn.onclick = sendMessage;
stopBtn.onclick = () => socket?.emit("stop");

promptInput.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
};

promptInput.oninput = () => {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + "px";
};

async function sendMessage() {
  const prompt = promptInput.value.trim();
  const hasImages = pendingImages.length > 0;

  if (!prompt && !hasImages) return;
  if (!socket || isStreaming) return;

  welcomeMessage?.remove();

  // Get image data URLs for display before clearing
  const imageDataUrls = pendingImages.map((img) => img.dataUrl);

  // Add user message with images
  addMessage(prompt, "user", imageDataUrls);
  conversationMessages.push({
    type: "user",
    content: prompt,
    images: imageDataUrls,
    timestamp: Date.now(),
  });

  // Upload images if any
  let imagePaths = [];
  if (hasImages) {
    try {
      sendBtn.disabled = true;
      sendBtn.textContent = "⬆";
      imagePaths = await uploadPendingImages();
    } catch (err) {
      showToast("Failed to upload images: " + err.message);
      sendBtn.disabled = false;
      sendBtn.textContent = "➤";
      return;
    }
  }

  // Clear pending images and input
  pendingImages = [];
  updateImagePreview();
  promptInput.value = "";
  promptInput.style.height = "auto";

  // Send message with image paths
  socket.emit("message", { prompt, imagePaths });

  // Save conversation immediately after sending (in case connection drops)
  autoSaveConversation();

  if (settings.vibrateEnabled && navigator.vibrate) {
    navigator.vibrate(10);
  }
}

function addMessage(content, type, images = []) {
  const div = document.createElement("div");
  div.className = `message ${type}`;

  if (type === "assistant") {
    div.dataset.raw = content;
    renderMarkdown(div);
  } else if (type === "user") {
    // Add images if present
    if (images && images.length > 0) {
      const imagesDiv = document.createElement("div");
      imagesDiv.className = "message-images";
      images.forEach((src) => {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "Uploaded image";
        img.onclick = () => openLightbox(src, "uploaded-image.png");
        imagesDiv.appendChild(img);
      });
      div.appendChild(imagesDiv);
    }
    // Add text content
    if (content) {
      const textDiv = document.createElement("div");
      textDiv.className = "message-text";
      textDiv.textContent = content;
      div.appendChild(textDiv);
    }
  } else {
    div.textContent = content;
  }

  messages.appendChild(div);
  if (settings.autoScroll) scrollToBottom();
  return div;
}

// Create or get the tool container for the current response
function getOrCreateToolContainer() {
  // Check if existing container is still in the DOM (not stale)
  if (currentToolContainer && currentToolContainer.parentNode === messages) {
    return currentToolContainer;
  }
  // Reset if stale reference
  currentToolContainer = null;
  toolCount = 0;

  const container = document.createElement("div");
  container.className = "tool-container collapsed";

  const header = document.createElement("div");
  header.className = "tool-container-header";
  header.innerHTML = `
    <span class="tool-container-icon">🔧</span>
    <span class="tool-container-title">Tools</span>
    <span class="tool-container-count"></span>
    <span class="tool-container-toggle">▶</span>
  `;

  const body = document.createElement("div");
  body.className = "tool-container-body";

  container.appendChild(header);
  container.appendChild(body);

  // Toggle expand/collapse on header click
  header.onclick = (e) => {
    e.stopPropagation();
    container.classList.toggle("collapsed");
    header.querySelector(".tool-container-toggle").textContent =
      container.classList.contains("collapsed") ? "▶" : "▼";
  };

  // Insert tool container BEFORE currentResponse so tools appear above the text
  // This matches the logical order: tools execute first, then Claude generates text
  if (currentResponse && currentResponse.parentNode === messages) {
    messages.insertBefore(container, currentResponse);
  } else {
    messages.appendChild(container);
  }
  currentToolContainer = container;
  return container;
}

// Update the tool container header with current count
function updateToolContainerHeader() {
  if (!currentToolContainer) return;
  const countEl = currentToolContainer.querySelector(".tool-container-count");
  if (countEl) {
    countEl.textContent = `(${toolCount} tool${toolCount !== 1 ? "s" : ""})`;
  }
}

// Add a tool to the container
function addToolToContainer(name, input, toolId) {
  const container = getOrCreateToolContainer();
  const body = container.querySelector(".tool-container-body");
  toolCount++;

  const item = document.createElement("div");
  item.className = "tool-item";
  if (toolId) {
    item.dataset.toolId = toolId;
  }

  const header = document.createElement("div");
  header.className = "tool-item-header";
  header.innerHTML = `<span>🔧 ${escapeHtml(name)}</span><span>▼</span>`;

  const content = document.createElement("div");
  content.className = "tool-content";
  content.textContent =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);

  item.appendChild(header);
  item.appendChild(content);

  // Toggle individual tool expand/collapse
  header.onclick = (e) => {
    e.stopPropagation();
    item.classList.toggle("expanded");
    header.querySelector("span:last-child").textContent =
      item.classList.contains("expanded") ? "▲" : "▼";
  };

  body.appendChild(item);
  updateToolContainerHeader();
  return item;
}

// Legacy function for compatibility
function addToolMessage(name, input, toolId) {
  return addToolToContainer(name, input, toolId);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Conversation history functions
function autoSaveConversation() {
  if (!socket || conversationMessages.length === 0) return;

  socket.emit("save-conversation", {
    id: currentConversationId,
    messages: conversationMessages,
    tokens: sessionTokens,
    workingDir: workingDir,
  });
}

function renderConversationList(conversations) {
  const historyList = document.getElementById("history-list");
  if (!historyList) return;

  // Filter by project if filter is set
  let filtered = conversations;
  if (historyProjectFilter) {
    filtered = conversations.filter((conv) => {
      const link = conversationLinksCache[conv.id];
      return link?.projectId === historyProjectFilter;
    });
  }

  if (filtered.length === 0) {
    if (historyProjectFilter) {
      historyList.innerHTML =
        '<div class="history-empty">No conversations in this project</div>';
    } else {
      historyList.innerHTML =
        '<div class="history-empty">No saved conversations</div>';
    }
    return;
  }

  historyList.innerHTML = filtered
    .map((conv) => {
      const date = new Date(conv.updatedAt).toLocaleDateString();
      const isActive = conv.id === currentConversationId;
      const link = conversationLinksCache[conv.id];
      const linkedProject = link
        ? projectsCache.find((p) => p.id === link.projectId)
        : null;
      const projectBadge = linkedProject
        ? `<span class="history-project-badge">${escapeHtml(linkedProject.name)}</span>`
        : "";
      const linkBtnClass = link
        ? "history-link-btn linked"
        : "history-link-btn";
      return `
        <div class="history-item ${isActive ? "active" : ""}" data-id="${conv.id}" style="position: relative;">
          <div class="history-item-content">
            <div class="history-title">${escapeHtml(conv.title)}${projectBadge}</div>
            <div class="history-meta">${conv.messageCount} messages · ${date}</div>
          </div>
          <div class="history-item-actions">
            <button class="${linkBtnClass}" data-id="${conv.id}" title="${link ? "Change project" : "Link to project"}">📁</button>
            <button class="history-delete" data-id="${conv.id}" title="Delete">×</button>
          </div>
        </div>
      `;
    })
    .join("");

  // Add click handlers
  historyList.querySelectorAll(".history-item").forEach((item) => {
    item.onclick = (e) => {
      if (
        e.target.classList.contains("history-delete") ||
        e.target.classList.contains("history-link-btn")
      )
        return;
      const id = item.dataset.id;
      socket.emit("load-conversation", { id });
      closeSidebar();
    };
  });

  historyList.querySelectorAll(".history-delete").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (confirm("Delete this conversation?")) {
        socket.emit("delete-conversation", { id });
      }
    };
  });

  // Add link button handlers
  historyList.querySelectorAll(".history-link-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const convId = btn.dataset.id;
      showConversationLinkDropdown(btn, convId);
    };
  });
}

// Show dropdown to link conversation to project
function showConversationLinkDropdown(anchorBtn, conversationId) {
  // Remove any existing dropdown
  const existing = document.querySelector(".history-link-dropdown");
  if (existing) existing.remove();

  const link = conversationLinksCache[conversationId];
  const dropdown = document.createElement("div");
  dropdown.className = "history-link-dropdown";

  let html = '<div class="history-link-dropdown-header">Link to Project</div>';

  // Add unlink option if linked
  if (link) {
    html += `<div class="history-link-dropdown-item unlink" data-action="unlink">Unlink from project</div>`;
  }

  // Add project options
  if (projectsCache.length === 0) {
    html +=
      '<div class="history-link-dropdown-item" style="color: var(--text-muted)">No projects available</div>';
  } else {
    for (const project of projectsCache) {
      const isCurrent = link?.projectId === project.id;
      const currentStyle = isCurrent
        ? ' style="background: var(--surface-2);"'
        : "";
      html += `<div class="history-link-dropdown-item"${currentStyle} data-project-id="${escapeHtml(project.id)}">${escapeHtml(project.name)}${isCurrent ? " ✓" : ""}</div>`;
    }
  }

  dropdown.innerHTML = html;

  // Position dropdown
  const rect = anchorBtn.getBoundingClientRect();
  dropdown.style.position = "fixed";
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${rect.left - 150}px`;

  document.body.appendChild(dropdown);

  // Handle clicks
  dropdown.querySelectorAll(".history-link-dropdown-item").forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation();
      const projectId = item.dataset.projectId;
      const action = item.dataset.action;

      if (action === "unlink") {
        socket.emit("conversation-unlink", { conversationId });
      } else if (projectId) {
        socket.emit("conversation-link", { conversationId, projectId });
      }

      dropdown.remove();
    };
  });

  // Close on outside click
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target !== anchorBtn) {
      dropdown.remove();
      document.removeEventListener("click", closeDropdown);
    }
  };
  setTimeout(() => document.addEventListener("click", closeDropdown), 0);
}

// Update history filter dropdown with projects
function updateHistoryProjectFilter() {
  if (!historyProjectFilterSelect) return;

  const currentValue = historyProjectFilterSelect.value;
  historyProjectFilterSelect.innerHTML =
    '<option value="">All Conversations</option>';

  for (const project of projectsCache) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    historyProjectFilterSelect.appendChild(option);
  }

  // Restore previous selection if still valid
  if (currentValue && projectsCache.some((p) => p.id === currentValue)) {
    historyProjectFilterSelect.value = currentValue;
  }
}

// History filter change handler
if (historyProjectFilterSelect) {
  historyProjectFilterSelect.onchange = () => {
    historyProjectFilter = historyProjectFilterSelect.value;
    renderConversationList(conversationsCache);
  };
}

function loadConversation(conversation) {
  // Clear current chat
  messages.innerHTML = "";
  conversationMessages = conversation.messages || [];
  currentConversationId = conversation.id;
  localStorage.setItem("claude-web-conversationId", currentConversationId);
  sessionTokens = conversation.tokens || {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  // Render messages
  for (const msg of conversationMessages) {
    if (msg.type === "user") {
      addMessage(msg.content, "user");
    } else if (msg.type === "assistant") {
      const div = addMessage("", "assistant");
      div.dataset.raw = msg.content;
      renderMarkdown(div);
    }
  }

  updateSessionTokenDisplay();
  showToast(`Loaded: ${conversation.title}`);

  // Scroll to bottom
  if (settings.autoScroll) scrollToBottom();
}

function formatTokens(count) {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

function updateSessionTokenDisplay() {
  let tokenDisplay = document.getElementById("session-tokens");
  if (!tokenDisplay) {
    // Create token display in header
    const headerRight = document.querySelector(".header-right");
    if (headerRight) {
      tokenDisplay = document.createElement("span");
      tokenDisplay.id = "session-tokens";
      tokenDisplay.className = "session-tokens";
      headerRight.insertBefore(tokenDisplay, headerRight.firstChild);
    }
  }
  if (tokenDisplay) {
    const total = sessionTokens.input + sessionTokens.output;
    tokenDisplay.textContent = `${formatTokens(total)} tokens`;
    tokenDisplay.title = `Input: ${formatTokens(sessionTokens.input)} | Output: ${formatTokens(sessionTokens.output)} | Cache read: ${formatTokens(sessionTokens.cacheRead)} | Cache write: ${formatTokens(sessionTokens.cacheWrite)}`;
  }
}

function updateContextDisplay(usage) {
  const MAX_CONTEXT = 200000; // Claude's context window
  let contextDisplay = document.getElementById("context-usage");

  if (!contextDisplay) {
    // Create context display in header
    const headerRight = document.querySelector(".header-right");
    if (headerRight) {
      contextDisplay = document.createElement("div");
      contextDisplay.id = "context-usage";
      contextDisplay.className = "context-usage";
      contextDisplay.innerHTML = `
        <div class="context-bar">
          <div class="context-fill-cached"></div>
          <div class="context-fill-new"></div>
        </div>
        <span class="context-text"></span>
        <span class="cache-rate"></span>
      `;
      headerRight.insertBefore(contextDisplay, headerRight.firstChild);
    }
  }

  if (contextDisplay) {
    const inputTokens = usage.input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const contextUsed = inputTokens + cacheRead;
    const totalPercentage = Math.min((contextUsed / MAX_CONTEXT) * 100, 100);
    const cachedPercentage = Math.min((cacheRead / MAX_CONTEXT) * 100, 100);
    const newPercentage = Math.min((inputTokens / MAX_CONTEXT) * 100, 100);
    const cacheHitRate = contextUsed > 0 ? (cacheRead / contextUsed) * 100 : 0;

    const fillCached = contextDisplay.querySelector(".context-fill-cached");
    const fillNew = contextDisplay.querySelector(".context-fill-new");
    const text = contextDisplay.querySelector(".context-text");
    const cacheRateEl = contextDisplay.querySelector(".cache-rate");

    if (fillCached) {
      fillCached.style.width = `${cachedPercentage}%`;
    }

    if (fillNew) {
      fillNew.style.width = `${newPercentage}%`;
      // Color new tokens based on total usage
      if (totalPercentage > 80) {
        fillNew.style.background = "var(--error)";
      } else if (totalPercentage > 50) {
        fillNew.style.background = "var(--warning)";
      } else {
        fillNew.style.background = "var(--primary)";
      }
    }

    if (text) {
      text.textContent = `${formatTokens(contextUsed)}/${formatTokens(MAX_CONTEXT)}`;
    }

    if (cacheRateEl) {
      cacheRateEl.textContent = `${Math.round(cacheHitRate)}%⚡`;
      cacheRateEl.style.color =
        cacheHitRate > 80
          ? "var(--success)"
          : cacheHitRate > 50
            ? "var(--warning)"
            : "var(--text-dim)";
    }

    contextDisplay.title = `Context: ${contextUsed.toLocaleString()} / ${MAX_CONTEXT.toLocaleString()} tokens\nCached: ${cacheRead.toLocaleString()} (${cacheHitRate.toFixed(1)}%)\nNew: ${inputTokens.toLocaleString()}`;
  }
}

function addTokenBadge(messageEl, usage, duration) {
  // Remove existing badge if any
  const existing = messageEl.querySelector(".token-badge");
  if (existing) existing.remove();

  const badge = document.createElement("div");
  badge.className = "token-badge";
  const durationSec = (duration / 1000).toFixed(1);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;

  let cacheInfo = "";
  if (cacheRead > 0) {
    cacheInfo = `<span class="token-cache" title="Cache hit">⚡${formatTokens(cacheRead)}</span>`;
  }

  badge.innerHTML = `<span class="token-in" title="Input tokens">↓${formatTokens(input)}</span><span class="token-out" title="Output tokens">↑${formatTokens(output)}</span>${cacheInfo}<span class="token-duration">${durationSec}s</span>`;
  badge.title = `Input: ${input} | Output: ${output} | Cache: ${cacheRead} | Duration: ${durationSec}s`;
  messageEl.appendChild(badge);
}

function renderMarkdown(element) {
  const raw = element.dataset.raw || "";

  // Pre-process: Extract and replace base64 images with placeholders
  const imageMap = new Map();
  let imageIndex = 0;
  let processedRaw = raw.replace(
    /data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+/gi,
    (match) => {
      const placeholder = `__IMAGE_PLACEHOLDER_${imageIndex}__`;
      imageMap.set(placeholder, match);
      imageIndex++;
      return placeholder;
    },
  );

  element.innerHTML = marked.parse(processedRaw);

  // Post-process: Replace placeholders with actual clickable images
  if (imageMap.size > 0) {
    let html = element.innerHTML;
    for (const [placeholder, dataUrl] of imageMap) {
      const imgHtml = `<div class="response-image"><img src="${dataUrl}" alt="Image" onclick="openLightbox('${dataUrl}', 'image.png')" /></div>`;
      html = html.replace(placeholder, imgHtml);
    }
    element.innerHTML = html;
  }

  // Post-process: Convert API image URLs to clickable images
  // Matches URLs like /api/images/filename.png or http://localhost:3001/api/images/filename.png
  const apiImageRegex =
    /(https?:\/\/[^/\s]*)?\/api\/images\/([a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp))/gi;
  let html = element.innerHTML;
  let hasApiImages = false;

  html = html.replace(apiImageRegex, (match, host, filename) => {
    hasApiImages = true;
    const url = `/api/images/${filename}`;
    return `<div class="response-image"><img src="${url}" alt="Screenshot" onclick="openLightbox('${url}', '${filename}')" /></div>`;
  });

  if (hasApiImages) {
    element.innerHTML = html;
  }

  // Add copy buttons to code blocks
  element.querySelectorAll("pre").forEach((pre) => {
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.onclick = (e) => {
      e.stopPropagation();
      const code = pre.querySelector("code")?.textContent || pre.textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 2000);
        showToast("Copied to clipboard");
      });
    };
    pre.appendChild(btn);
  });

  // Highlight code blocks
  element.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block);
  });
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// Sidebar handlers
menuBtn.onclick = openSidebar;
closeSidebarBtn.onclick = closeSidebar;
sidebarOverlay.onclick = closeSidebar;

function openSidebar() {
  sidebar.classList.remove("hidden");
  sidebarOverlay.classList.remove("hidden");
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
}

function closeSidebar() {
  sidebar.classList.add("hidden");
  sidebarOverlay.classList.add("hidden");
}

// Swipe to open sidebar
let touchStartX = 0;
document.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
});

document.addEventListener("touchend", (e) => {
  const touchEndX = e.changedTouches[0].clientX;
  const diff = touchEndX - touchStartX;

  if (touchStartX < 30 && diff > 100) {
    openSidebar();
  } else if (diff < -100 && !sidebar.classList.contains("hidden")) {
    closeSidebar();
  }
});

// Settings handlers
settingsBtn.onclick = () => {
  settingsModal.classList.remove("hidden");
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
};

closeSettingsBtn.onclick = () => {
  settingsModal.classList.add("hidden");
};

settingsModal.onclick = (e) => {
  if (e.target === settingsModal) settingsModal.classList.add("hidden");
};

// Theme toggle
document.getElementById("theme-dark").onclick = () => setTheme("dark");
document.getElementById("theme-light").onclick = () => setTheme("light");

function setTheme(theme) {
  settings.theme = theme;
  localStorage.setItem("theme", theme);
  applySettings();

  document
    .getElementById("theme-dark")
    .classList.toggle("active", theme === "dark");
  document
    .getElementById("theme-light")
    .classList.toggle("active", theme === "light");
}

// Font size controls
document.getElementById("font-decrease").onclick = () =>
  setFontSize(settings.fontSize - 2);
document.getElementById("font-increase").onclick = () =>
  setFontSize(settings.fontSize + 2);

function setFontSize(size) {
  settings.fontSize = Math.max(12, Math.min(24, size));
  localStorage.setItem("fontSize", settings.fontSize);
  applySettings();
  document.getElementById("font-size-display").textContent =
    settings.fontSize + "px";
}

// Checkbox settings
document.getElementById("sound-enabled").onchange = (e) => {
  settings.soundEnabled = e.target.checked;
  localStorage.setItem("soundEnabled", settings.soundEnabled);
};

document.getElementById("auto-scroll").onchange = (e) => {
  settings.autoScroll = e.target.checked;
  localStorage.setItem("autoScroll", settings.autoScroll);
};

document.getElementById("show-tools").onchange = (e) => {
  settings.showTools = e.target.checked;
  localStorage.setItem("showTools", settings.showTools);
};

document.getElementById("vibrate-enabled").onchange = (e) => {
  settings.vibrateEnabled = e.target.checked;
  localStorage.setItem("vibrateEnabled", settings.vibrateEnabled);
};

document.getElementById("push-enabled").onchange = async (e) => {
  settings.pushEnabled = e.target.checked;
  localStorage.setItem("pushEnabled", settings.pushEnabled);

  // Subscribe or unsubscribe from push
  if (settings.pushEnabled && !pushSubscription) {
    showToast("Requesting notification permission...");
    const success = await subscribeToPush();
    if (success) {
      showToast("Push notifications enabled");
      // Send to server immediately
      if (socket?.connected && pushSubscription) {
        socket.emit("push-subscribe", {
          subscription: pushSubscription.toJSON(),
        });
      }
    } else {
      showToast("Failed to enable push notifications");
      e.target.checked = false;
      settings.pushEnabled = false;
      localStorage.setItem("pushEnabled", "false");
    }
  } else if (!settings.pushEnabled && pushSubscription) {
    try {
      await pushSubscription.unsubscribe();
      pushSubscription = null;
      if (socket?.connected) {
        socket.emit("push-unsubscribe");
      }
      showToast("Push notifications disabled");
    } catch (err) {
      console.error("Failed to unsubscribe from push:", err);
    }
  }
};

// Model selection
document.getElementById("model-select").onchange = (e) => {
  settings.model = e.target.value;
  localStorage.setItem("claude-model", settings.model);
  showToast(
    `Model set to ${e.target.options[e.target.selectedIndex].text}. Takes effect on next session.`,
  );
};

// Logout
document.getElementById("logout-btn").onclick = () => {
  localStorage.removeItem("claude-web-token");
  location.reload();
};

function applySettings() {
  document.body.classList.toggle("light-theme", settings.theme === "light");
  document.documentElement.style.setProperty(
    "--font-size",
    settings.fontSize + "px",
  );

  // Update checkbox states
  const soundEnabled = document.getElementById("sound-enabled");
  const autoScroll = document.getElementById("auto-scroll");
  const showTools = document.getElementById("show-tools");
  const vibrateEnabled = document.getElementById("vibrate-enabled");
  const pushEnabled = document.getElementById("push-enabled");

  if (soundEnabled) soundEnabled.checked = settings.soundEnabled;
  if (autoScroll) autoScroll.checked = settings.autoScroll;
  if (showTools) showTools.checked = settings.showTools;
  if (vibrateEnabled) vibrateEnabled.checked = settings.vibrateEnabled;
  if (pushEnabled) pushEnabled.checked = settings.pushEnabled;

  // Set model select value
  const modelSelect = document.getElementById("model-select");
  if (modelSelect) modelSelect.value = settings.model;

  document.getElementById("font-size-display").textContent =
    settings.fontSize + "px";
}

// Session controls
document.getElementById("new-session-btn").onclick = () => {
  if (socket) {
    // Clear stored session ID to force a fresh start
    currentSessionId = null;
    localStorage.removeItem("claude-web-sessionId");
    localStorage.removeItem("claude-web-conversationId");
    socket.emit("start-session", {
      workingDir: expandPath(workingDir),
      model: settings.model,
    });
    messages.innerHTML = "";
    conversationMessages = [];
    currentConversationId = null;
    sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    updateSessionTokenDisplay();
    showToast("New session started");
    closeSidebar();
  }
};

document.getElementById("clear-chat-btn").onclick = () => {
  messages.innerHTML = "";
  showToast("Chat cleared");
  closeSidebar();
};

document.getElementById("export-btn").onclick = () => {
  const chatContent = [];
  messages.querySelectorAll(".message").forEach((msg) => {
    const type = msg.classList.contains("user")
      ? "User"
      : msg.classList.contains("assistant")
        ? "Claude"
        : msg.classList.contains("tool")
          ? "Tool"
          : "System";
    const content = msg.dataset.raw || msg.textContent;
    chatContent.push(`## ${type}\n\n${content}\n`);
  });

  const blob = new Blob([chatContent.join("\n---\n\n")], {
    type: "text/markdown",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `claude-chat-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);

  showToast("Chat exported");
  closeSidebar();
};

// Working directory
dirSetBtn.onclick = () => {
  const newDir = dirInput.value.trim();
  if (newDir) {
    workingDir = newDir;
    localStorage.setItem("claude-web-workingDir", workingDir);
    updateWorkingDirDisplay();

    if (socket) {
      socket.emit("start-session", {
        workingDir: expandPath(workingDir),
        model: settings.model,
      });
      showToast(`Working directory: ${workingDir}`);
    }

    loadFileList(workingDir);
  }
};

function updateWorkingDirDisplay() {
  workingDirDisplay.textContent = workingDir;
  dirInput.value = workingDir;
  document.getElementById("file-current-path").textContent = workingDir;
}

function expandPath(path) {
  if (path.startsWith("~")) {
    return path; // Server will expand
  }
  return path;
}

// Quick actions
document.querySelectorAll(".quick-btn").forEach((btn) => {
  btn.onclick = () => {
    const prompt = btn.dataset.prompt;
    if (prompt && socket && !isStreaming) {
      promptInput.value = prompt;
      sendMessage();
      closeSidebar();
    }
  };
});

// File browser
function loadFileList(path) {
  if (socket) {
    socket.emit("list-files", { path: expandPath(path) });
  }
}

document.getElementById("file-up-btn").onclick = () => {
  const currentPath = document.getElementById("file-current-path").textContent;
  const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
  loadFileList(parentPath);
};

function renderFileList(files, path) {
  const fileList = document.getElementById("file-list");
  document.getElementById("file-current-path").textContent = path;

  fileList.innerHTML = files
    .map(
      (file) => `
    <div class="file-item ${file.isDirectory ? "directory" : ""}" data-path="${file.path}" data-is-dir="${file.isDirectory}">
      <span class="file-icon">${file.isDirectory ? "📁" : "📄"}</span>
      <span class="file-name">${file.name}</span>
    </div>
  `,
    )
    .join("");

  fileList.querySelectorAll(".file-item").forEach((item) => {
    item.onclick = () => {
      const itemPath = item.dataset.path;
      const isDir = item.dataset.isDir === "true";

      if (isDir) {
        loadFileList(itemPath);
      } else {
        // Insert file path into prompt
        promptInput.value += (promptInput.value ? " " : "") + itemPath;
        promptInput.focus();
        closeSidebar();
        showToast("File path added to prompt");
      }
    };
  });
}

// Voice input
if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join("");
    promptInput.value = transcript;
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + "px";
  };

  recognition.onend = () => {
    voiceBtn.classList.remove("recording");
  };

  recognition.onerror = () => {
    voiceBtn.classList.remove("recording");
    showToast("Voice recognition error");
  };

  voiceBtn.onclick = () => {
    if (voiceBtn.classList.contains("recording")) {
      recognition.stop();
    } else {
      recognition.start();
      voiceBtn.classList.add("recording");
      showToast("Listening...");
      if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(50);
    }
  };
} else {
  voiceBtn.style.display = "none";
}

// Toast notification
function showToast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// Image upload handling
uploadBtn.onclick = () => {
  fileUpload.click();
};

fileUpload.onchange = async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  // Check total image count
  if (pendingImages.length + files.length > MAX_IMAGES_PER_MESSAGE) {
    showToast(`Maximum ${MAX_IMAGES_PER_MESSAGE} images per message`);
    fileUpload.value = "";
    return;
  }

  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      showToast("Only image files are supported");
      continue;
    }

    // Check file size
    if (file.size > MAX_IMAGE_SIZE) {
      showToast(`Image too large (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`);
      continue;
    }

    // Read file as data URL for preview
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target.result;
      pendingImages.push({ file, dataUrl, name: file.name, type: file.type });
      updateImagePreview();
    };
    reader.readAsDataURL(file);
  }

  // Reset input so same file can be selected again
  fileUpload.value = "";
};

function updateImagePreview() {
  if (pendingImages.length === 0) {
    imagePreviewArea.classList.add("hidden");
    imagePreviewArea.innerHTML = "";
    return;
  }

  imagePreviewArea.classList.remove("hidden");
  imagePreviewArea.innerHTML = pendingImages
    .map(
      (img, index) => `
      <div class="preview-item" data-index="${index}">
        <img src="${img.dataUrl}" alt="${escapeHtml(img.name)}" />
        <button class="preview-remove" data-index="${index}">×</button>
      </div>
    `,
    )
    .join("");

  // Add remove handlers
  imagePreviewArea.querySelectorAll(".preview-remove").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      pendingImages.splice(index, 1);
      updateImagePreview();
    };
  });

  // Add click to expand handlers
  imagePreviewArea.querySelectorAll(".preview-item img").forEach((img) => {
    img.onclick = () => openLightbox(img.src);
  });
}

async function uploadPendingImages() {
  if (pendingImages.length === 0) return [];

  return new Promise((resolve, reject) => {
    const images = pendingImages.map((img) => ({
      name: img.name,
      type: img.type,
      data: img.dataUrl,
    }));

    socket.emit("upload-images", { images });

    const onComplete = (data) => {
      socket.off("upload-complete", onComplete);
      socket.off("upload-error", onError);
      resolve(data.paths);
    };

    const onError = (data) => {
      socket.off("upload-complete", onComplete);
      socket.off("upload-error", onError);
      reject(new Error(data.message));
    };

    socket.once("upload-complete", onComplete);
    socket.once("upload-error", onError);
  });
}

// Image lightbox
function openLightbox(src, downloadName) {
  // Validate src is a data URL or valid image path
  if (!src || typeof src !== "string") return;
  if (
    !src.startsWith("data:image/") &&
    !src.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)
  ) {
    console.warn("Invalid image source for lightbox");
    return;
  }
  lightboxImage.src = src;
  lightboxImage.dataset.downloadName = downloadName || "image.png";
  imageLightbox.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  imageLightbox.classList.add("hidden");
  document.body.style.overflow = "";
}

lightboxClose.onclick = closeLightbox;
imageLightbox.querySelector(".lightbox-overlay").onclick = closeLightbox;

lightboxDownload.onclick = () => {
  const link = document.createElement("a");
  link.href = lightboxImage.src;
  link.download = lightboxImage.dataset.downloadName || "image.png";
  link.click();
  showToast("Image downloaded");
};

// Detect and render base64 images in tool output
function renderImageContent(content) {
  if (!content || typeof content !== "string") return null;

  // Check for base64 image data URL
  const base64Match = content.match(
    /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/i,
  );
  if (base64Match) {
    return base64Match[0];
  }

  // Check for raw base64 that looks like an image (starts with magic bytes in base64)
  const trimmed = content.trim();
  if (trimmed.length > 100) {
    // PNG: iVBOR, JPEG: /9j/, GIF: R0lGOD, WebP: UklGR
    if (trimmed.startsWith("iVBOR")) {
      return `data:image/png;base64,${trimmed}`;
    } else if (trimmed.startsWith("/9j/")) {
      return `data:image/jpeg;base64,${trimmed}`;
    } else if (trimmed.startsWith("R0lGOD")) {
      return `data:image/gif;base64,${trimmed}`;
    } else if (trimmed.startsWith("UklGR")) {
      return `data:image/webp;base64,${trimmed}`;
    }
  }

  return null;
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  // Escape to close modals
  if (e.key === "Escape") {
    if (!imageLightbox.classList.contains("hidden")) {
      closeLightbox();
    } else if (!settingsModal.classList.contains("hidden")) {
      settingsModal.classList.add("hidden");
    } else if (!sidebar.classList.contains("hidden")) {
      closeSidebar();
    }
  }

  // Ctrl+Enter to send
  if (e.key === "Enter" && e.ctrlKey) {
    sendMessage();
  }
});

// Save conversation when page goes to background (mobile screen off, tab switch)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    // Save immediately when page is hidden
    autoSaveConversation();

    // Also save any partial response that's still streaming
    if (currentResponse && currentResponse.dataset.raw) {
      conversationMessages.push({
        type: "assistant",
        content:
          currentResponse.dataset.raw + "\n\n*[Response may be incomplete]*",
        timestamp: Date.now(),
      });
      autoSaveConversation();
    }
  }
});

// Save conversation before page closes or refreshes
window.addEventListener("beforeunload", () => {
  autoSaveConversation();
});

// Periodic save during long responses (every 30 seconds)
let periodicSaveInterval = null;

function startPeriodicSave() {
  if (periodicSaveInterval) return;
  periodicSaveInterval = setInterval(() => {
    if (conversationMessages.length > 0) {
      autoSaveConversation();
    }
  }, 30000);
}

function stopPeriodicSave() {
  if (periodicSaveInterval) {
    clearInterval(periodicSaveInterval);
    periodicSaveInterval = null;
  }
}

// Start periodic save when connected
startPeriodicSave();

// PWA install prompt
let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

// Quick Actions Management
const defaultQuickActions = [
  {
    emoji: "✅",
    label: "TODOs",
    prompt:
      "Read ~/.claude/workspace/TODOS.md and show me the current tasks, what's completed, and what's still pending",
  },
  {
    emoji: "📜",
    label: "Recent Commits",
    prompt: "Summarize the recent git commits",
  },
  {
    emoji: "📸",
    label: "Screenshot",
    prompt: "Take a screenshot of the current browser page using puppeteer",
  },
  {
    emoji: "🎯",
    label: "Full Review",
    prompt:
      "Run a full-stack review on the recent changes - check code quality, security, performance, and best practices",
  },
  {
    emoji: "🚀",
    label: "Commit & Push",
    prompt: "/commit then push to the remote repository",
  },
];

let quickActions = JSON.parse(
  localStorage.getItem("claude-web-quickActions"),
) || [...defaultQuickActions];
const actionsModal = document.getElementById("actions-modal");
const actionsList = document.getElementById("actions-list");
const manageActionsBtn = document.getElementById("manage-actions-btn");
const closeActionsModalBtn = document.getElementById("close-actions-modal");
const addActionBtn = document.getElementById("add-action-btn");
const resetActionsBtn = document.getElementById("reset-actions-btn");

// Render quick actions in sidebar
function renderQuickActions() {
  const quickActionsContainer = document.getElementById("quick-actions");
  quickActionsContainer.innerHTML = quickActions
    .map(
      (action, index) => `
    <button class="quick-btn" data-index="${index}" data-prompt="${escapeHtml(action.prompt)}">
      ${escapeHtml(action.emoji)} ${escapeHtml(action.label)}
    </button>
  `,
    )
    .join("");

  // Re-attach click handlers
  quickActionsContainer.querySelectorAll(".quick-btn").forEach((btn) => {
    btn.onclick = () => {
      const prompt = btn.dataset.prompt;
      if (prompt && socket && !isStreaming) {
        promptInput.value = prompt;
        sendMessage();
        closeSidebar();
      }
    };
  });
}

// Quick Actions Bar (above input area)
const quickActionsBar = document.getElementById("quick-actions-bar");
const toggleActionsBarBtn = document.getElementById("toggle-actions-bar");
const actionsBarContent = document.getElementById("actions-bar-content");

function renderActionsBar() {
  if (!actionsBarContent) return;

  actionsBarContent.innerHTML = quickActions
    .map(
      (action, index) => `
      <button class="action-bar-btn" data-index="${index}" data-prompt="${escapeHtml(action.prompt)}" title="${escapeHtml(action.prompt)}">
        ${escapeHtml(action.emoji)} ${escapeHtml(action.label)}
      </button>
    `,
    )
    .join("");

  // Attach click handlers
  actionsBarContent.querySelectorAll(".action-bar-btn").forEach((btn) => {
    btn.onclick = () => {
      const prompt = btn.dataset.prompt;
      if (prompt && socket && !isStreaming) {
        promptInput.value = prompt;
        sendMessage();
        if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
      }
    };
  });

  // Update disabled state based on streaming
  updateActionsBarState();
}

function updateActionsBarState() {
  if (!actionsBarContent) return;
  // Check if socket exists and is connected (socket.connected for socket.io)
  const isConnected =
    socket && (socket.connected || status?.classList.contains("connected"));
  actionsBarContent.querySelectorAll(".action-bar-btn").forEach((btn) => {
    btn.disabled = isStreaming || !isConnected;
  });
}

function toggleActionsBar() {
  if (!quickActionsBar) return;
  quickActionsBar.classList.toggle("collapsed");
  localStorage.setItem(
    "claude-web-actionsBarCollapsed",
    quickActionsBar.classList.contains("collapsed"),
  );
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
}

// Initialize actions bar toggle
if (toggleActionsBarBtn) {
  toggleActionsBarBtn.onclick = toggleActionsBar;
}

// Restore collapsed state
const actionsBarCollapsed = localStorage.getItem(
  "claude-web-actionsBarCollapsed",
);
if (actionsBarCollapsed === "false" && quickActionsBar) {
  quickActionsBar.classList.remove("collapsed");
}

// Render actions in modal for editing
function renderActionsModal() {
  if (quickActions.length === 0) {
    actionsList.innerHTML =
      '<div class="actions-empty">No quick actions. Click "Add Action" to create one.</div>';
    return;
  }

  actionsList.innerHTML = quickActions
    .map(
      (action, index) => `
    <div class="action-item" draggable="true" data-index="${index}">
      <div class="action-move-btns">
        <button class="action-move-btn" data-index="${index}" data-dir="up" title="Move up" ${index === 0 ? "disabled" : ""}>▲</button>
        <button class="action-move-btn" data-index="${index}" data-dir="down" title="Move down" ${index === quickActions.length - 1 ? "disabled" : ""}>▼</button>
      </div>
      <span class="action-drag-handle">⋮⋮</span>
      <div class="action-emoji">${escapeHtml(action.emoji)}</div>
      <div class="action-details">
        <div class="action-label">${escapeHtml(action.label)}</div>
        <div class="action-prompt">${escapeHtml(action.prompt)}</div>
      </div>
      <div class="action-buttons">
        <button class="action-edit-btn" data-index="${index}" title="Edit">✏️</button>
        <button class="action-delete-btn" data-index="${index}" title="Delete">🗑️</button>
      </div>
    </div>
  `,
    )
    .join("");

  // Attach edit handlers
  actionsList.querySelectorAll(".action-edit-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      editAction(index);
    };
  });

  // Attach delete handlers
  actionsList.querySelectorAll(".action-delete-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      if (confirm("Delete this action?")) {
        quickActions.splice(index, 1);
        saveQuickActions();
        renderActionsModal();
        renderQuickActions();
        renderActionsBar();
      }
    };
  });

  // Attach move button handlers (mobile-friendly reordering)
  actionsList.querySelectorAll(".action-move-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      const dir = btn.dataset.dir;
      let moved = false;
      if (dir === "up" && index > 0) {
        [quickActions[index], quickActions[index - 1]] = [
          quickActions[index - 1],
          quickActions[index],
        ];
        moved = true;
      } else if (dir === "down" && index < quickActions.length - 1) {
        [quickActions[index], quickActions[index + 1]] = [
          quickActions[index + 1],
          quickActions[index],
        ];
        moved = true;
      }
      if (moved) {
        saveQuickActions();
        renderActionsModal();
        renderQuickActions();
        renderActionsBar();
        if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
      }
    };
  });

  // Attach drag handlers
  attachDragHandlers();
}

function editAction(index) {
  const action = quickActions[index];
  const item = actionsList.querySelector(`.action-item[data-index="${index}"]`);

  item.innerHTML = `
    <span class="action-drag-handle">⋮⋮</span>
    <div class="action-emoji">
      <input type="text" value="${escapeHtml(action.emoji)}" maxlength="4" class="edit-emoji">
    </div>
    <div class="action-details">
      <input type="text" value="${escapeHtml(action.label)}" placeholder="Label" class="edit-label action-label">
      <input type="text" value="${escapeHtml(action.prompt)}" placeholder="Prompt" class="edit-prompt action-prompt">
    </div>
    <div class="action-buttons">
      <button class="action-save-btn" title="Save">✓</button>
      <button class="action-cancel-btn" title="Cancel">✕</button>
    </div>
  `;
  item.draggable = false;

  const emojiInputEl = item.querySelector(".edit-emoji");
  const labelInputEl = item.querySelector(".edit-label");
  const promptInputEl = item.querySelector(".edit-prompt");
  const saveBtn = item.querySelector(".action-save-btn");
  const cancelBtn = item.querySelector(".action-cancel-btn");

  labelInputEl.focus();

  saveBtn.onclick = () => {
    quickActions[index] = {
      emoji: emojiInputEl.value || "⚡",
      label: labelInputEl.value || "Action",
      prompt: promptInputEl.value || "Do something",
    };
    saveQuickActions();
    renderActionsModal();
    renderQuickActions();
    renderActionsBar();
  };

  cancelBtn.onclick = () => {
    renderActionsModal();
  };

  // Save on Enter in any input
  [emojiInputEl, labelInputEl, promptInputEl].forEach((input) => {
    input.onkeydown = (e) => {
      if (e.key === "Enter") saveBtn.click();
      if (e.key === "Escape") cancelBtn.click();
    };
  });
}

function addNewAction() {
  quickActions.push({
    emoji: "⚡",
    label: "New Action",
    prompt: "Enter your prompt here",
  });
  saveQuickActions();
  renderActionsModal();
  // Immediately edit the new action
  editAction(quickActions.length - 1);
  // Scroll to bottom of list
  actionsList.scrollTop = actionsList.scrollHeight;
}

function saveQuickActions() {
  localStorage.setItem("claude-web-quickActions", JSON.stringify(quickActions));
}

// Drag and drop reordering
let draggedIndex = null;

function attachDragHandlers() {
  const items = actionsList.querySelectorAll(".action-item");

  items.forEach((item) => {
    item.ondragstart = (e) => {
      draggedIndex = parseInt(item.dataset.index);
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    };

    item.ondragend = () => {
      item.classList.remove("dragging");
      actionsList
        .querySelectorAll(".action-item")
        .forEach((i) => i.classList.remove("drag-over"));
      draggedIndex = null;
    };

    item.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const targetIndex = parseInt(item.dataset.index);
      if (targetIndex !== draggedIndex) {
        item.classList.add("drag-over");
      }
    };

    item.ondragleave = () => {
      item.classList.remove("drag-over");
    };

    item.ondrop = (e) => {
      e.preventDefault();
      item.classList.remove("drag-over");
      const targetIndex = parseInt(item.dataset.index);

      if (draggedIndex !== null && draggedIndex !== targetIndex) {
        // Reorder array
        const [removed] = quickActions.splice(draggedIndex, 1);
        quickActions.splice(targetIndex, 0, removed);
        saveQuickActions();
        renderActionsModal();
        renderQuickActions();
        renderActionsBar();
      }
    };
  });
}

// Modal handlers
manageActionsBtn.onclick = () => {
  renderActionsModal();
  actionsModal.classList.remove("hidden");
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
};

closeActionsModalBtn.onclick = () => {
  actionsModal.classList.add("hidden");
};

actionsModal.onclick = (e) => {
  if (e.target === actionsModal) actionsModal.classList.add("hidden");
};

addActionBtn.onclick = addNewAction;

resetActionsBtn.onclick = () => {
  if (confirm("Reset all quick actions to default?")) {
    quickActions = [...defaultQuickActions];
    saveQuickActions();
    renderActionsModal();
    renderQuickActions();
    renderActionsBar();
    showToast("Quick actions reset to default");
  }
};

// Initialize quick actions on load
renderQuickActions();
renderActionsBar();

// ============================================
// Message Search Functionality
// ============================================

const searchBtn = document.getElementById("search-btn");
const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const searchCount = document.getElementById("search-count");
const searchPrev = document.getElementById("search-prev");
const searchNext = document.getElementById("search-next");
const searchClose = document.getElementById("search-close");

let searchMatches = [];
let currentMatchIndex = -1;
let searchDebounceTimer = null;

function openSearch() {
  searchBar.classList.remove("hidden");
  searchInput.focus();
  searchInput.select();
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
}

function closeSearch() {
  searchBar.classList.add("hidden");
  clearSearchHighlights();
  searchInput.value = "";
  searchMatches = [];
  currentMatchIndex = -1;
  updateSearchCount();
}

function clearSearchHighlights() {
  // Remove all highlight spans and restore original text
  document.querySelectorAll(".search-highlight").forEach((el) => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize(); // Merge adjacent text nodes
  });
}

function highlightMatches(query) {
  clearSearchHighlights();
  searchMatches = [];
  currentMatchIndex = -1;

  if (!query || query.length < 2) {
    updateSearchCount();
    return;
  }

  const messages = document.querySelectorAll("#messages .message");
  const lowerQuery = query.toLowerCase();

  messages.forEach((message) => {
    // Get text nodes to search (skip tool containers which are collapsible)
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // Skip if inside a tool container (collapsed by default)
        const parent = node.parentElement;
        if (parent?.closest(".tool-container")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    textNodes.forEach((textNode) => {
      const text = textNode.textContent;
      const lowerText = text.toLowerCase();
      let startIndex = 0;
      let index;

      // Find all occurrences
      const matches = [];
      while ((index = lowerText.indexOf(lowerQuery, startIndex)) !== -1) {
        matches.push({ start: index, end: index + query.length });
        startIndex = index + 1;
      }

      if (matches.length === 0) return;

      // Replace text node with highlighted spans
      const fragment = document.createDocumentFragment();
      let lastEnd = 0;

      matches.forEach((match) => {
        // Add text before match
        if (match.start > lastEnd) {
          fragment.appendChild(
            document.createTextNode(text.slice(lastEnd, match.start)),
          );
        }
        // Add highlighted match
        const span = document.createElement("span");
        span.className = "search-highlight";
        span.textContent = text.slice(match.start, match.end);
        fragment.appendChild(span);
        searchMatches.push(span);
        lastEnd = match.end;
      });

      // Add remaining text
      if (lastEnd < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
      }

      textNode.parentNode.replaceChild(fragment, textNode);
    });
  });

  updateSearchCount();

  // Go to first match if any
  if (searchMatches.length > 0) {
    goToMatch(0);
  }
}

function updateSearchCount() {
  if (searchMatches.length === 0) {
    if (searchInput.value.length >= 2) {
      searchCount.textContent = "No matches";
      searchCount.classList.add("no-matches");
    } else {
      searchCount.textContent = "";
      searchCount.classList.remove("no-matches");
    }
    searchPrev.disabled = true;
    searchNext.disabled = true;
  } else {
    searchCount.textContent = `${currentMatchIndex + 1}/${searchMatches.length}`;
    searchCount.classList.remove("no-matches");
    searchPrev.disabled = false;
    searchNext.disabled = false;
  }
}

function goToMatch(index) {
  // Remove current highlight
  if (currentMatchIndex >= 0 && searchMatches[currentMatchIndex]?.isConnected) {
    searchMatches[currentMatchIndex].classList.remove("current");
  }

  // Wrap around
  if (index < 0) index = searchMatches.length - 1;
  if (index >= searchMatches.length) index = 0;

  currentMatchIndex = index;

  // Highlight current match (check if still in DOM)
  const match = searchMatches[currentMatchIndex];
  if (match?.isConnected) {
    match.classList.add("current");
    match.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  updateSearchCount();
}

function performSearch() {
  const query = searchInput.value.trim();
  highlightMatches(query);
}

// Event handlers
searchBtn.onclick = () => {
  if (searchBar.classList.contains("hidden")) {
    openSearch();
  } else {
    closeSearch();
  }
};

searchClose.onclick = closeSearch;

searchInput.oninput = () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(performSearch, 200);
};

searchInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      goToMatch(currentMatchIndex - 1);
    } else {
      goToMatch(currentMatchIndex + 1);
    }
  } else if (e.key === "Escape") {
    closeSearch();
  }
};

searchPrev.onclick = () => goToMatch(currentMatchIndex - 1);
searchNext.onclick = () => goToMatch(currentMatchIndex + 1);

// Global keyboard shortcut: Ctrl+F / Cmd+F
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    openSearch();
  }
});

// ============================================
// Mobile Keyboard Handling
// ============================================

// Detect if running on mobile
const isMobile =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );

if (isMobile && window.visualViewport) {
  const inputArea = document.getElementById("input-area");
  const quickActionsBar = document.getElementById("quick-actions-bar");

  // Position input at bottom of visual viewport (above keyboard)
  const repositionInput = () => {
    const vv = window.visualViewport;
    // Calculate where bottom of visual viewport is relative to layout viewport
    const offsetTop = vv.offsetTop;
    const bottomOfViewport = offsetTop + vv.height;

    // Position input area at bottom of visual viewport
    if (inputArea) {
      inputArea.style.position = "fixed";
      inputArea.style.bottom = "auto";
      inputArea.style.top = `${bottomOfViewport - inputArea.offsetHeight}px`;
      inputArea.style.left = "0";
      inputArea.style.right = "0";
    }

    // Position quick actions bar above input
    if (quickActionsBar && !quickActionsBar.classList.contains("collapsed")) {
      quickActionsBar.style.position = "fixed";
      quickActionsBar.style.bottom = "auto";
      quickActionsBar.style.top = `${bottomOfViewport - inputArea.offsetHeight - quickActionsBar.offsetHeight}px`;
      quickActionsBar.style.left = "0";
      quickActionsBar.style.right = "0";
    }
  };

  const resetInputPosition = () => {
    if (inputArea) {
      inputArea.style.position = "";
      inputArea.style.bottom = "";
      inputArea.style.top = "";
      inputArea.style.left = "";
      inputArea.style.right = "";
    }
    if (quickActionsBar) {
      quickActionsBar.style.position = "";
      quickActionsBar.style.bottom = "";
      quickActionsBar.style.top = "";
      quickActionsBar.style.left = "";
      quickActionsBar.style.right = "";
    }
  };

  // Track if input is focused
  let inputFocused = false;

  promptInput.addEventListener("focus", () => {
    inputFocused = true;
    // Small delay to let keyboard start opening
    setTimeout(repositionInput, 50);
  });

  promptInput.addEventListener("blur", () => {
    inputFocused = false;
    // Delay reset to avoid flicker
    setTimeout(() => {
      if (!inputFocused) {
        resetInputPosition();
      }
    }, 100);
  });

  // Update position as keyboard animates open/closed
  window.visualViewport.addEventListener("resize", () => {
    if (inputFocused) {
      repositionInput();
    }
  });

  window.visualViewport.addEventListener("scroll", () => {
    if (inputFocused) {
      repositionInput();
    }
  });
}

// ============================================
// Memory UI (MCP Knowledge Graph)
// ============================================

// Memory state
let memoryCache = { entities: [], relations: [] };
let selectedEntity = null;
let memorySearchQuery = "";
let memoryActiveTab = "entities";

// Memory elements
const memoryBtn = document.getElementById("memory-btn");
const memoryModal = document.getElementById("memory-modal");
const closeMemoryModal = document.getElementById("close-memory-modal");
const memorySearchInput = document.getElementById("memory-search-input");
const memoryRefreshBtn = document.getElementById("memory-refresh-btn");
const memoryTabs = document.querySelectorAll(".memory-tab");
const memoryEntitiesList = document.getElementById("memory-entities-list");
const memoryRelationsList = document.getElementById("memory-relations-list");
const memoryStats = document.getElementById("memory-stats");

// Entity detail elements
const entityDetailModal = document.getElementById("entity-detail-modal");
const closeEntityDetail = document.getElementById("close-entity-detail");
const entityDetailBack = document.getElementById("entity-detail-back");
const entityDetailTitle = document.getElementById("entity-detail-title");
const entityDetailType = document.getElementById("entity-detail-type");
const entityDetailObservations = document.getElementById(
  "entity-detail-observations",
);
const entityDetailRelations = document.getElementById(
  "entity-detail-relations",
);

// Open Memory Modal
function openMemoryModal() {
  memoryModal.classList.remove("hidden");
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);

  // Load graph if not cached or stale
  if (memoryCache.entities.length === 0) {
    loadMemoryGraph();
  } else {
    renderMemoryContent();
  }
}

// Close Memory Modal
function closeMemoryModalFn() {
  memoryModal.classList.add("hidden");
}

// Load memory graph from server
function loadMemoryGraph(forceRefresh = false) {
  if (!socket?.connected) {
    renderMemoryError("Not connected to server");
    return;
  }

  renderMemoryLoading();
  socket.emit("memory-read-graph", { forceRefresh });
}

// Search memory
function searchMemory(query) {
  memorySearchQuery = query.trim();

  if (memorySearchQuery.length === 0) {
    // Show all from cache
    renderMemoryContent();
    return;
  }

  if (memorySearchQuery.length < 2) {
    return; // Wait for at least 2 chars
  }

  // Filter client-side for instant feedback
  renderMemoryContent();
}

// Render memory content (entities or relations based on active tab)
function renderMemoryContent() {
  renderEntitiesList();
  renderRelationsList();
  updateMemoryStats();
}

// Filter entities by search query
function getFilteredEntities() {
  if (!memorySearchQuery) {
    return memoryCache.entities;
  }

  const query = memorySearchQuery.toLowerCase();
  return memoryCache.entities.filter((entity) => {
    const nameMatch = entity.name?.toLowerCase().includes(query);
    const typeMatch = entity.entityType?.toLowerCase().includes(query);
    const obsMatch = entity.observations?.some((obs) =>
      obs.toLowerCase().includes(query),
    );
    return nameMatch || typeMatch || obsMatch;
  });
}

// Filter relations by search query
function getFilteredRelations() {
  if (!memorySearchQuery) {
    return memoryCache.relations;
  }

  const query = memorySearchQuery.toLowerCase();
  return memoryCache.relations.filter((rel) => {
    const fromMatch = rel.from?.toLowerCase().includes(query);
    const toMatch = rel.to?.toLowerCase().includes(query);
    const typeMatch = rel.relationType?.toLowerCase().includes(query);
    return fromMatch || toMatch || typeMatch;
  });
}

// Render entities list
function renderEntitiesList() {
  const entities = getFilteredEntities();

  if (entities.length === 0) {
    if (memorySearchQuery) {
      memoryEntitiesList.innerHTML =
        '<div class="memory-empty">No entities match your search</div>';
    } else {
      memoryEntitiesList.innerHTML =
        '<div class="memory-empty">No entities in memory</div>';
    }
    return;
  }

  memoryEntitiesList.innerHTML = entities
    .map((entity) => {
      const obsPreview =
        entity.observations?.slice(0, 2).join(" | ").substring(0, 100) || "";
      const obsCount = entity.observations?.length || 0;

      return `
        <div class="entity-card" data-name="${escapeHtml(entity.name)}">
          <div class="entity-card-header">
            <span class="entity-name">${escapeHtml(entity.name)}</span>
            <span class="entity-type-badge">${escapeHtml(entity.entityType || "Unknown")}</span>
          </div>
          ${obsPreview ? `<div class="entity-observations-preview">${escapeHtml(obsPreview)}${obsPreview.length >= 100 ? "..." : ""}</div>` : ""}
          <div class="entity-observations-count">${obsCount} observation${obsCount !== 1 ? "s" : ""}</div>
        </div>
      `;
    })
    .join("");

  // Attach click handlers
  memoryEntitiesList.querySelectorAll(".entity-card").forEach((card) => {
    card.onclick = () => {
      const name = card.dataset.name;
      const entity = memoryCache.entities.find((e) => e.name === name);
      if (entity) {
        openEntityDetail(entity);
      }
    };
  });
}

// Render relations list
function renderRelationsList() {
  const relations = getFilteredRelations();

  if (relations.length === 0) {
    if (memorySearchQuery) {
      memoryRelationsList.innerHTML =
        '<div class="memory-empty">No relations match your search</div>';
    } else {
      memoryRelationsList.innerHTML =
        '<div class="memory-empty">No relations in memory</div>';
    }
    return;
  }

  memoryRelationsList.innerHTML = relations
    .map(
      (rel) => `
      <div class="relation-card" data-from="${escapeHtml(rel.from)}" data-to="${escapeHtml(rel.to)}">
        <span class="relation-from">${escapeHtml(rel.from)}</span>
        <span class="relation-arrow">→</span>
        <span class="relation-type">${escapeHtml(rel.relationType)}</span>
        <span class="relation-arrow">→</span>
        <span class="relation-to">${escapeHtml(rel.to)}</span>
      </div>
    `,
    )
    .join("");

  // Attach click handlers - clicking opens the "from" entity
  memoryRelationsList.querySelectorAll(".relation-card").forEach((card) => {
    card.onclick = () => {
      const fromName = card.dataset.from;
      const entity = memoryCache.entities.find((e) => e.name === fromName);
      if (entity) {
        openEntityDetail(entity);
      }
    };
  });
}

// Update memory stats
function updateMemoryStats() {
  const entityCount = memoryCache.entities.length;
  const relationCount = memoryCache.relations.length;
  const filteredEntities = getFilteredEntities().length;
  const filteredRelations = getFilteredRelations().length;

  if (memorySearchQuery) {
    memoryStats.textContent = `Showing ${filteredEntities}/${entityCount} entities, ${filteredRelations}/${relationCount} relations`;
  } else {
    memoryStats.textContent = `${entityCount} entities, ${relationCount} relations`;
  }
}

// Render loading state
function renderMemoryLoading() {
  memoryEntitiesList.innerHTML = '<div class="memory-loading">Loading...</div>';
  memoryRelationsList.innerHTML =
    '<div class="memory-loading">Loading...</div>';
  memoryStats.textContent = "Loading...";
}

// Render error state
function renderMemoryError(message) {
  const errorHtml = `<div class="memory-error">Error: ${escapeHtml(message)}</div>`;
  memoryEntitiesList.innerHTML = errorHtml;
  memoryRelationsList.innerHTML = errorHtml;
  memoryStats.textContent = "Error loading memory";
}

// Open entity detail modal
function openEntityDetail(entity) {
  selectedEntity = entity;

  // Set title and type
  entityDetailTitle.textContent = entity.name;
  entityDetailType.textContent = entity.entityType || "Unknown";

  // Render observations
  if (entity.observations && entity.observations.length > 0) {
    entityDetailObservations.innerHTML = entity.observations
      .map((obs) => `<div class="observation-item">${escapeHtml(obs)}</div>`)
      .join("");
  } else {
    entityDetailObservations.innerHTML =
      '<div class="memory-empty">No observations</div>';
  }

  // Render relations for this entity
  const entityRelations = memoryCache.relations.filter(
    (rel) => rel.from === entity.name || rel.to === entity.name,
  );

  if (entityRelations.length > 0) {
    entityDetailRelations.innerHTML = entityRelations
      .map((rel) => {
        const isOutgoing = rel.from === entity.name;
        const targetName = isOutgoing ? rel.to : rel.from;
        const directionClass = isOutgoing ? "outgoing" : "incoming";
        const directionLabel = isOutgoing ? "→" : "←";

        return `
          <div class="entity-relation-item ${directionClass}" data-target="${escapeHtml(targetName)}">
            <span class="entity-relation-direction">${directionLabel}</span>
            <span class="entity-relation-type">${escapeHtml(rel.relationType)}</span>
            <span class="entity-relation-target">${escapeHtml(targetName)}</span>
          </div>
        `;
      })
      .join("");

    // Attach click handlers to navigate to related entities
    entityDetailRelations
      .querySelectorAll(".entity-relation-target")
      .forEach((el) => {
        el.onclick = (e) => {
          e.stopPropagation();
          const targetName = el.parentElement.dataset.target;
          const targetEntity = memoryCache.entities.find(
            (ent) => ent.name === targetName,
          );
          if (targetEntity) {
            openEntityDetail(targetEntity);
          }
        };
      });
  } else {
    entityDetailRelations.innerHTML =
      '<div class="memory-empty">No relations</div>';
  }

  // Show the detail modal
  entityDetailModal.classList.remove("hidden");
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
}

// Close entity detail modal
function closeEntityDetailFn() {
  entityDetailModal.classList.add("hidden");
  selectedEntity = null;
}

// Switch memory tabs
function switchMemoryTab(tabName) {
  memoryActiveTab = tabName;

  // Update tab buttons
  memoryTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  // Update tab content
  document
    .getElementById("memory-entities-tab")
    .classList.toggle("active", tabName === "entities");
  document
    .getElementById("memory-relations-tab")
    .classList.toggle("active", tabName === "relations");
}

// Event handlers
if (memoryBtn) {
  memoryBtn.onclick = openMemoryModal;
}

if (closeMemoryModal) {
  closeMemoryModal.onclick = closeMemoryModalFn;
}

if (memoryModal) {
  memoryModal.onclick = (e) => {
    if (e.target === memoryModal) closeMemoryModalFn();
  };
}

if (memoryRefreshBtn) {
  memoryRefreshBtn.onclick = () => {
    loadMemoryGraph(true);
    if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);
  };
}

if (memorySearchInput) {
  let memorySearchDebounce = null;
  memorySearchInput.oninput = () => {
    clearTimeout(memorySearchDebounce);
    memorySearchDebounce = setTimeout(() => {
      searchMemory(memorySearchInput.value);
    }, 200);
  };
}

memoryTabs.forEach((tab) => {
  tab.onclick = () => switchMemoryTab(tab.dataset.tab);
});

if (closeEntityDetail) {
  closeEntityDetail.onclick = closeEntityDetailFn;
}

if (entityDetailBack) {
  entityDetailBack.onclick = closeEntityDetailFn;
}

if (entityDetailModal) {
  entityDetailModal.onclick = (e) => {
    if (e.target === entityDetailModal) closeEntityDetailFn();
  };
}

// Socket.io listeners for memory - track if already setup to prevent duplicates
let memoryListenersSetup = false;

function setupMemorySocketListeners() {
  if (!socket || memoryListenersSetup) return;
  memoryListenersSetup = true;

  socket.on("memory-graph", (data) => {
    console.log("Memory graph received:", data);
    memoryCache = {
      entities: Array.isArray(data.entities) ? data.entities : [],
      relations: Array.isArray(data.relations) ? data.relations : [],
    };
    renderMemoryContent();
  });

  socket.on("memory-search-results", (data) => {
    console.log("Memory search results:", data);
    // Update entities with search results but keep relations from cache
    if (data.query === memorySearchQuery) {
      // Only update if this is for our current query
      renderMemoryContent();
    }
  });

  socket.on("memory-entity", (data) => {
    console.log("Memory entity received:", data);
    if (data.entity) {
      openEntityDetail(data.entity);
    }
  });

  socket.on("memory-error", (data) => {
    console.error("Memory error:", data);
    renderMemoryError(data.message || "Unknown error");
    showToast(`Memory error: ${data.message}`);
  });

  // Reset flag on disconnect so listeners can be reattached on reconnect
  socket.on("disconnect", () => {
    memoryListenersSetup = false;
  });
}

// Keyboard shortcut: Escape closes memory modals
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!entityDetailModal.classList.contains("hidden")) {
      closeEntityDetailFn();
    } else if (!memoryModal.classList.contains("hidden")) {
      closeMemoryModalFn();
    }
  }
});

// ============================================
// Browser Preview
// ============================================

// Browser Preview State
let browserPreviewMode = "iframe"; // "iframe" | "puppeteer" | "html"
let currentViewport = "desktop"; // "mobile" | "tablet" | "desktop"
let puppeteerClickMode = false;
let browserPreviewListenersSetup = false;

// Browser Preview Elements
const browserPreviewBtn = document.getElementById("browser-preview-btn");
const browserPreviewModal = document.getElementById("browser-preview-modal");
const closeBrowserPreviewBtn = document.getElementById("close-browser-preview");
const browserPreviewPopoutBtn = document.getElementById(
  "browser-preview-popout",
);
const browserPreviewTabs = document.querySelectorAll(".browser-preview-tab");
const browserPreviewUrlInput = document.getElementById("browser-preview-url");
const browserPreviewGoBtn = document.getElementById("browser-preview-go");
const browserPreviewRefreshBtn = document.getElementById(
  "browser-preview-refresh",
);
const browserPreviewContainer = document.querySelector(
  ".browser-preview-container",
);
const browserPreviewStatusText = document.getElementById(
  "browser-preview-status-text",
);

// Iframe tab elements
const browserPreviewIframe = document.getElementById("browser-preview-iframe");

// Puppeteer tab elements
const puppeteerScreenshot = document.getElementById("puppeteer-screenshot");
const puppeteerLoading = document.getElementById("puppeteer-loading");
const puppeteerPlaceholder = document.getElementById("puppeteer-placeholder");
const puppeteerClickModeBtn = document.getElementById("puppeteer-click-mode");
const puppeteerDevtoolsBtn = document.getElementById("puppeteer-devtools");
const puppeteerControls = document.querySelector(".puppeteer-controls");

// HTML tab elements
const htmlPreviewInput = document.getElementById("html-preview-input");
const htmlPreviewRenderBtn = document.getElementById("html-preview-render");
const htmlPreviewIframe = document.getElementById("html-preview-iframe");

// DevTools elements
const devtoolsModal = document.getElementById("devtools-modal");
const closeDevtoolsBtn = document.getElementById("close-devtools");
const devtoolsOutput = document.getElementById("devtools-output");
const devtoolsInput = document.getElementById("devtools-input");
const devtoolsRunBtn = document.getElementById("devtools-run");

// Viewport buttons
const viewportButtons = document.querySelectorAll(".viewport-btn");

// Open Browser Preview Modal
function openBrowserPreview() {
  browserPreviewModal.classList.remove("hidden");
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);

  // Setup socket listeners if not already
  if (socket?.connected && !browserPreviewListenersSetup) {
    setupBrowserPreviewSocketListeners();
  }
}

// Close Browser Preview Modal
function closeBrowserPreviewFn() {
  browserPreviewModal.classList.add("hidden");
}

// Switch Browser Preview Tab
function switchBrowserPreviewTab(tabName) {
  browserPreviewMode = tabName;

  // Update tab buttons
  browserPreviewTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  // Update tab content
  document
    .getElementById("browser-preview-iframe-tab")
    .classList.toggle("active", tabName === "iframe");
  document
    .getElementById("browser-preview-puppeteer-tab")
    .classList.toggle("active", tabName === "puppeteer");
  document
    .getElementById("browser-preview-html-tab")
    .classList.toggle("active", tabName === "html");

  // Show/hide puppeteer controls
  if (puppeteerControls) {
    puppeteerControls.classList.toggle("hidden", tabName !== "puppeteer");
  }

  // Update URL bar placeholder based on mode
  if (tabName === "html") {
    browserPreviewUrlInput.placeholder = "N/A for HTML mode";
    browserPreviewUrlInput.disabled = true;
  } else {
    browserPreviewUrlInput.placeholder = "http://localhost:5173";
    browserPreviewUrlInput.disabled = false;
  }
}

// Validate URL for security (prevent protocol injection)
function validateBrowserUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return null;

  // Normalize and parse URL
  let url;
  try {
    // If no protocol, prepend http://
    if (!urlString.match(/^https?:\/\//i)) {
      urlString = "http://" + urlString;
    }
    url = new URL(urlString);
  } catch {
    return null;
  }

  // Only allow http and https protocols
  if (!["http:", "https:"].includes(url.protocol)) {
    return null;
  }

  return url.href;
}

// Navigate in Iframe mode
function navigateIframe(url) {
  if (!url) return;

  const validatedUrl = validateBrowserUrl(url);
  if (!validatedUrl) {
    showToast("Invalid URL - only http/https allowed");
    updateBrowserStatus("Invalid URL");
    return;
  }

  browserPreviewUrlInput.value = validatedUrl;

  try {
    browserPreviewIframe.src = validatedUrl;
    updateBrowserStatus("Loading...");
  } catch (err) {
    updateBrowserStatus("Error loading URL");
    showToast("Failed to load URL in iframe");
  }
}

// Navigate in Puppeteer mode
function navigatePuppeteer(url) {
  if (!url) return;

  const validatedUrl = validateBrowserUrl(url);
  if (!validatedUrl) {
    showToast("Invalid URL - only http/https allowed");
    updateBrowserStatus("Invalid URL");
    return;
  }

  browserPreviewUrlInput.value = validatedUrl;

  // Show loading state
  puppeteerScreenshot.classList.add("hidden");
  puppeteerPlaceholder.classList.add("hidden");
  puppeteerLoading.classList.remove("hidden");
  updateBrowserStatus("Navigating...");

  // Send navigate request
  socket.emit("browser-navigate", { url: validatedUrl });
}

// Take Puppeteer screenshot
function takePuppeteerScreenshot() {
  const viewport = getViewportDimensions();
  puppeteerLoading.classList.remove("hidden");
  updateBrowserStatus("Taking screenshot...");
  socket.emit("browser-screenshot", viewport);
}

// Get viewport dimensions based on current setting
function getViewportDimensions() {
  switch (currentViewport) {
    case "mobile":
      return { width: 375, height: 667 };
    case "tablet":
      return { width: 768, height: 1024 };
    default:
      return { width: 1280, height: 800 };
  }
}

// Set viewport
function setViewport(viewport) {
  currentViewport = viewport;

  // Update button states
  viewportButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.viewport === viewport);
  });

  // Update container class
  browserPreviewContainer.classList.remove(
    "viewport-mobile",
    "viewport-tablet",
    "viewport-desktop",
  );
  browserPreviewContainer.classList.add(`viewport-${viewport}`);

  // If in puppeteer mode, retake screenshot with new viewport
  if (
    browserPreviewMode === "puppeteer" &&
    !puppeteerScreenshot.classList.contains("hidden")
  ) {
    takePuppeteerScreenshot();
  }
}

// Render HTML Preview
// Note: HTML preview is intentionally for testing/development use
// The iframe is sandboxed without allow-same-origin to prevent access to parent
function renderHtmlPreview() {
  const html = htmlPreviewInput.value;
  if (!html.trim()) {
    showToast("Enter some HTML to render");
    return;
  }

  // Wrap in a basic HTML document if not already complete
  let wrappedHtml = html;
  if (
    !html.toLowerCase().includes("<!doctype") &&
    !html.toLowerCase().includes("<html")
  ) {
    wrappedHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${html}</body></html>`;
  }

  htmlPreviewIframe.srcdoc = wrappedHtml;
  updateBrowserStatus("HTML rendered");
}

// Handle screenshot click for coordinate-based interaction
function handleScreenshotClick(event) {
  if (!puppeteerClickMode) return;

  const rect = puppeteerScreenshot.getBoundingClientRect();
  const naturalWidth = puppeteerScreenshot.naturalWidth;
  const naturalHeight = puppeteerScreenshot.naturalHeight;

  // Validate dimensions to prevent division by zero
  if (!rect.width || !rect.height || !naturalWidth || !naturalHeight) {
    showToast("Screenshot not fully loaded");
    return;
  }

  const scaleX = naturalWidth / rect.width;
  const scaleY = naturalHeight / rect.height;

  const x = Math.round((event.clientX - rect.left) * scaleX);
  const y = Math.round((event.clientY - rect.top) * scaleY);

  // Validate coordinates are within bounds
  if (x < 0 || y < 0 || x > naturalWidth || y > naturalHeight) {
    showToast("Click outside screenshot bounds");
    return;
  }

  updateBrowserStatus(`Clicking at (${x}, ${y})...`);
  socket.emit("browser-click", { x, y });
}

// Update browser status text
function updateBrowserStatus(text) {
  if (browserPreviewStatusText) {
    browserPreviewStatusText.textContent = text;
  }
}

// Open DevTools modal
function openDevtools() {
  devtoolsModal.classList.remove("hidden");
}

// Close DevTools modal
function closeDevtoolsFn() {
  devtoolsModal.classList.add("hidden");
}

// Run JavaScript in DevTools
function runDevtoolsScript() {
  const script = devtoolsInput.value.trim();
  if (!script) return;

  // Add input to output
  const inputEntry = document.createElement("div");
  inputEntry.className = "log-entry";
  inputEntry.innerHTML = `<div class="log-input">${escapeHtml(script)}</div>`;
  devtoolsOutput.appendChild(inputEntry);

  // Send to server
  socket.emit("browser-evaluate", { script });

  // Clear input
  devtoolsInput.value = "";

  // Scroll to bottom
  devtoolsOutput.scrollTop = devtoolsOutput.scrollHeight;
}

// Add log entry to DevTools output
function addDevtoolsLog(content, isError = false) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const outputClass = isError ? "log-error" : "log-output";
  entry.innerHTML = `<div class="${outputClass}">${escapeHtml(String(content))}</div>`;
  devtoolsOutput.appendChild(entry);
  devtoolsOutput.scrollTop = devtoolsOutput.scrollHeight;
}

// Setup Browser Preview Socket Listeners
function setupBrowserPreviewSocketListeners() {
  if (!socket || browserPreviewListenersSetup) return;
  browserPreviewListenersSetup = true;

  socket.on("browser-navigated", (data) => {
    console.log("Browser navigated:", data);
    if (data.success) {
      updateBrowserStatus(`Loaded: ${data.url}`);
      // Take screenshot after navigation
      takePuppeteerScreenshot();
    } else {
      updateBrowserStatus(`Error: ${data.error}`);
      puppeteerLoading.classList.add("hidden");
      puppeteerPlaceholder.classList.remove("hidden");
      showToast(`Navigation failed: ${data.error}`);
    }
  });

  socket.on("browser-screenshot-ready", (data) => {
    console.log("Screenshot ready:", data.success);
    puppeteerLoading.classList.add("hidden");

    if (data.success && data.data) {
      puppeteerPlaceholder.classList.add("hidden");
      puppeteerScreenshot.src = data.data;
      puppeteerScreenshot.classList.remove("hidden");
      updateBrowserStatus("Screenshot captured");
    } else {
      updateBrowserStatus(`Screenshot error: ${data.error}`);
      showToast(`Screenshot failed: ${data.error}`);
    }
  });

  socket.on("browser-clicked", (data) => {
    console.log("Browser clicked:", data);
    if (data.success) {
      updateBrowserStatus("Clicked - taking new screenshot...");
      // Take a new screenshot to show the result
      setTimeout(takePuppeteerScreenshot, 500);
    } else {
      updateBrowserStatus(`Click error: ${data.error}`);
    }
  });

  socket.on("browser-evaluated", (data) => {
    console.log("Browser evaluated:", data);
    if (data.success) {
      addDevtoolsLog(JSON.stringify(data.result, null, 2));
    } else {
      addDevtoolsLog(data.error, true);
    }
  });

  socket.on("browser-filled", (data) => {
    console.log("Browser filled:", data);
    if (data.success) {
      updateBrowserStatus("Input filled - taking new screenshot...");
      setTimeout(takePuppeteerScreenshot, 300);
    } else {
      updateBrowserStatus(`Fill error: ${data.error}`);
    }
  });

  socket.on("browser-error", (data) => {
    console.error("Browser error:", data);
    updateBrowserStatus(`Error: ${data.message}`);
    puppeteerLoading.classList.add("hidden");
    showToast(`Browser error: ${data.message}`);
  });

  // Reset flag on disconnect
  socket.on("disconnect", () => {
    browserPreviewListenersSetup = false;
  });
}

// Event Handlers - Browser Preview Button
if (browserPreviewBtn) {
  browserPreviewBtn.onclick = openBrowserPreview;
}

// Close button
if (closeBrowserPreviewBtn) {
  closeBrowserPreviewBtn.onclick = closeBrowserPreviewFn;
}

// Modal background click to close
if (browserPreviewModal) {
  browserPreviewModal.onclick = (e) => {
    if (e.target === browserPreviewModal) closeBrowserPreviewFn();
  };
}

// Popout button - open URL in new window
if (browserPreviewPopoutBtn) {
  browserPreviewPopoutBtn.onclick = () => {
    const url = browserPreviewUrlInput.value.trim();
    if (url) {
      window.open(url, "_blank");
    }
  };
}

// Tab switching
browserPreviewTabs.forEach((tab) => {
  tab.onclick = () => switchBrowserPreviewTab(tab.dataset.tab);
});

// URL bar - Go button
if (browserPreviewGoBtn) {
  browserPreviewGoBtn.onclick = () => {
    const url = browserPreviewUrlInput.value.trim();
    if (!url) {
      showToast("Enter a URL");
      return;
    }

    if (browserPreviewMode === "iframe") {
      navigateIframe(url);
    } else if (browserPreviewMode === "puppeteer") {
      navigatePuppeteer(url);
    }
  };
}

// URL bar - Refresh button
if (browserPreviewRefreshBtn) {
  browserPreviewRefreshBtn.onclick = () => {
    if (browserPreviewMode === "iframe") {
      browserPreviewIframe.src = browserPreviewIframe.src;
      updateBrowserStatus("Refreshing...");
    } else if (browserPreviewMode === "puppeteer") {
      takePuppeteerScreenshot();
    }
  };
}

// URL bar - Enter to navigate
if (browserPreviewUrlInput) {
  browserPreviewUrlInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      browserPreviewGoBtn.click();
    }
  };
}

// Viewport buttons
viewportButtons.forEach((btn) => {
  btn.onclick = () => setViewport(btn.dataset.viewport);
});

// Puppeteer click mode toggle
if (puppeteerClickModeBtn) {
  puppeteerClickModeBtn.onclick = () => {
    puppeteerClickMode = !puppeteerClickMode;
    puppeteerClickModeBtn.classList.toggle("active", puppeteerClickMode);
    puppeteerScreenshot.classList.toggle("click-mode", puppeteerClickMode);
    updateBrowserStatus(
      puppeteerClickMode
        ? "Click mode ON - click on screenshot to interact"
        : "Click mode OFF",
    );
  };
}

// Puppeteer screenshot click handler
if (puppeteerScreenshot) {
  puppeteerScreenshot.onclick = handleScreenshotClick;
}

// DevTools button
if (puppeteerDevtoolsBtn) {
  puppeteerDevtoolsBtn.onclick = openDevtools;
}

// DevTools close button
if (closeDevtoolsBtn) {
  closeDevtoolsBtn.onclick = closeDevtoolsFn;
}

// DevTools modal background click to close
if (devtoolsModal) {
  devtoolsModal.onclick = (e) => {
    if (e.target === devtoolsModal) closeDevtoolsFn();
  };
}

// DevTools run button
if (devtoolsRunBtn) {
  devtoolsRunBtn.onclick = runDevtoolsScript;
}

// DevTools input - Ctrl+Enter to run
if (devtoolsInput) {
  devtoolsInput.onkeydown = (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      runDevtoolsScript();
    }
  };
}

// HTML preview render button
if (htmlPreviewRenderBtn) {
  htmlPreviewRenderBtn.onclick = renderHtmlPreview;
}

// Iframe load event to update status
if (browserPreviewIframe) {
  browserPreviewIframe.onload = () => {
    updateBrowserStatus("Loaded");
  };
  browserPreviewIframe.onerror = () => {
    updateBrowserStatus("Failed to load");
  };
}

// Keyboard shortcut: Escape closes browser preview modals
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!devtoolsModal.classList.contains("hidden")) {
      closeDevtoolsFn();
    } else if (!browserPreviewModal.classList.contains("hidden")) {
      closeBrowserPreviewFn();
    }
  }
});

// ============================================
// Project Management
// ============================================

// Project State (projectsCache and activeProjectId declared at top of file)
let currentEditingProject = null;
let currentEditingTask = null;
let currentEditingFolder = null;
let tasksCache = [];
let foldersCache = [];
let projectActiveTab = "list";
let projectListenersSetup = false;
let contextFilesTemp = [];

// Project Elements
const projectBtn = document.getElementById("project-btn");
const projectModal = document.getElementById("project-modal");
const closeProjectModal = document.getElementById("close-project-modal");
const projectTabs = document.querySelectorAll(".project-tab");
const projectListTab = document.getElementById("project-list-tab");
const projectTasksTab = document.getElementById("project-tasks-tab");
const projectList = document.getElementById("project-list");
const newProjectBtn = document.getElementById("new-project-btn");
const activeProjectName = document.getElementById("active-project-name");

// Task Elements
const tasksProjectName = document.getElementById("tasks-project-name");
const newTaskBtn = document.getElementById("new-task-btn");
const taskList = document.getElementById("task-list");

// Folder Elements
const projectFoldersTab = document.getElementById("project-folders-tab");
const foldersProjectName = document.getElementById("folders-project-name");
const newFolderBtn = document.getElementById("new-folder-btn");
const folderList = document.getElementById("folder-list");

// Folder Edit Modal Elements
const folderEditModal = document.getElementById("folder-edit-modal");
const closeFolderEdit = document.getElementById("close-folder-edit");
const folderEditBack = document.getElementById("folder-edit-back");
const folderEditTitle = document.getElementById("folder-edit-title");
const folderNameInput = document.getElementById("folder-name-input");
const folderDeleteBtn = document.getElementById("folder-delete-btn");
const folderCancelBtn = document.getElementById("folder-cancel-btn");
const folderSaveBtn = document.getElementById("folder-save-btn");

// Project Edit Modal Elements
const projectEditModal = document.getElementById("project-edit-modal");
const closeProjectEdit = document.getElementById("close-project-edit");
const projectEditBack = document.getElementById("project-edit-back");
const projectEditTitle = document.getElementById("project-edit-title");
const projectNameInput = document.getElementById("project-name-input");
const projectDirInput = document.getElementById("project-dir-input");
const projectDirBrowse = document.getElementById("project-dir-browse");
const projectModelSelect = document.getElementById("project-model-select");
const projectContextFiles = document.getElementById("project-context-files");
const addContextFileBtn = document.getElementById("add-context-file-btn");
const projectDeleteBtn = document.getElementById("project-delete-btn");
const projectCancelBtn = document.getElementById("project-cancel-btn");
const projectSaveBtn = document.getElementById("project-save-btn");

// Task Edit Modal Elements
const taskEditModal = document.getElementById("task-edit-modal");
const closeTaskEdit = document.getElementById("close-task-edit");
const taskEditBack = document.getElementById("task-edit-back");
const taskEditTitle = document.getElementById("task-edit-title");
const taskTitleInput = document.getElementById("task-title-input");
const taskDescriptionInput = document.getElementById("task-description-input");
const taskPrioritySelect = document.getElementById("task-priority-select");
const taskStatusSelect = document.getElementById("task-status-select");
const taskStatusGroup = document.getElementById("task-status-group");
const taskDeleteBtn = document.getElementById("task-delete-btn");
const taskCancelBtn = document.getElementById("task-cancel-btn");
const taskSaveBtn = document.getElementById("task-save-btn");

// Open Project Modal
function openProjectModal() {
  if (!projectModal) return;
  projectModal.classList.remove("hidden");
  if (settings.vibrateEnabled && navigator.vibrate) navigator.vibrate(10);

  // Setup socket listeners if not already
  if (socket?.connected && !projectListenersSetup) {
    setupProjectSocketListeners();
  }

  // Load projects
  loadProjects();
}

// Close Project Modal
function closeProjectModalFn() {
  if (projectModal) projectModal.classList.add("hidden");
}

// Load projects from server
function loadProjects() {
  if (!socket?.connected) return;
  socket.emit("project-list");
}

// Load tasks for a project
function loadTasks(projectId) {
  if (!socket?.connected || !projectId) return;
  socket.emit("task-list", { projectId });
}

// Load folders for a project
function loadFolders(projectId) {
  if (!socket?.connected || !projectId) return;
  socket.emit("folder-list", { projectId });
}

// Switch Project Tab
function switchProjectTab(tabName) {
  projectActiveTab = tabName;

  // Update tab buttons
  projectTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  // Update tab content
  if (projectListTab)
    projectListTab.classList.toggle("active", tabName === "list");
  if (projectTasksTab)
    projectTasksTab.classList.toggle("active", tabName === "tasks");
  if (projectFoldersTab)
    projectFoldersTab.classList.toggle("active", tabName === "folders");

  // Load tasks when switching to tasks tab
  if (tabName === "tasks" && activeProjectId) {
    loadTasks(activeProjectId);
  }

  // Load folders when switching to folders tab
  if (tabName === "folders" && activeProjectId) {
    loadFolders(activeProjectId);
  }
}

// Render Projects List
function renderProjectsList() {
  if (!projectList) return;

  if (projectsCache.length === 0) {
    projectList.innerHTML =
      '<div class="project-empty">No projects yet. Create one to get started.</div>';
    return;
  }

  projectList.innerHTML = projectsCache
    .map(
      (project) => `
    <div class="project-card ${project.id === activeProjectId ? "active" : ""}" data-id="${escapeHtml(project.id)}">
      <div class="project-card-header">
        <span class="project-name">${escapeHtml(project.name)}</span>
        <span class="project-model-badge">${escapeHtml(project.model || "opus")}</span>
      </div>
      <div class="project-path">${escapeHtml(project.workingDir || project.working_dir || "")}</div>
      <div class="project-stats">
        <span>${project.activeTasks || project.active_tasks || 0} tasks</span>
        <span>${project.conversationCount || project.conversation_count || 0} conversations</span>
      </div>
      <div class="project-card-actions">
        <button class="project-card-btn activate-btn" data-action="activate" title="${project.id === activeProjectId ? "Deactivate" : "Activate"}">
          ${project.id === activeProjectId ? "✓ Active" : "Activate"}
        </button>
        <button class="project-card-btn" data-action="edit" title="Edit">Edit</button>
      </div>
    </div>
  `,
    )
    .join("");

  // Attach click handlers
  projectList.querySelectorAll(".project-card").forEach((card) => {
    const projectId = card.dataset.id;

    card.querySelector('[data-action="activate"]').onclick = (e) => {
      e.stopPropagation();
      const project = projectsCache.find((p) => p.id === projectId);
      if (project) {
        if (projectId === activeProjectId) {
          // Deactivate
          socket.emit("project-activate", { id: null });
        } else {
          // Activate
          socket.emit("project-activate", { id: projectId });
        }
      }
    };

    card.querySelector('[data-action="edit"]').onclick = (e) => {
      e.stopPropagation();
      const project = projectsCache.find((p) => p.id === projectId);
      if (project) openProjectEditModal(project);
    };

    // Clicking card opens tasks
    card.onclick = () => {
      const project = projectsCache.find((p) => p.id === projectId);
      if (project) {
        // Activate the project if not active
        if (projectId !== activeProjectId) {
          socket.emit("project-activate", { id: projectId });
        }
        switchProjectTab("tasks");
      }
    };
  });

  // Update active project indicator
  updateActiveProjectIndicator();
}

// Update Active Project Indicator
function updateActiveProjectIndicator() {
  if (!activeProjectName) return;

  const activeProject = projectsCache.find((p) => p.id === activeProjectId);
  if (activeProject) {
    activeProjectName.textContent = activeProject.name;
    activeProjectName.classList.remove("none");
  } else {
    activeProjectName.textContent = "None";
    activeProjectName.classList.add("none");
  }

  // Update tasks tab project name
  if (tasksProjectName) {
    if (activeProject) {
      tasksProjectName.textContent = activeProject.name;
      if (newTaskBtn) newTaskBtn.disabled = false;
    } else {
      tasksProjectName.textContent = "No project selected";
      if (newTaskBtn) newTaskBtn.disabled = true;
    }
  }

  // Update folders tab project name
  if (foldersProjectName) {
    if (activeProject) {
      foldersProjectName.textContent = activeProject.name;
      if (newFolderBtn) newFolderBtn.disabled = false;
    } else {
      foldersProjectName.textContent = "No project selected";
      if (newFolderBtn) newFolderBtn.disabled = true;
    }
  }
}

// Render Tasks List
function renderTasksList() {
  if (!taskList) return;

  if (!activeProjectId) {
    taskList.innerHTML =
      '<div class="project-empty">Select a project to view tasks.</div>';
    return;
  }

  if (tasksCache.length === 0) {
    taskList.innerHTML =
      '<div class="project-empty">No tasks yet. Create one to get started.</div>';
    return;
  }

  // Group tasks by status
  const pending = tasksCache.filter((t) => t.status === "pending");
  const inProgress = tasksCache.filter((t) => t.status === "in_progress");
  const completed = tasksCache.filter((t) => t.status === "completed");

  const renderTaskCard = (task) => `
    <div class="task-card status-${task.status} priority-${task.priority}" data-id="${escapeHtml(task.id)}">
      <div class="task-checkbox" data-action="toggle"></div>
      <div class="task-content">
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-meta">
          <span class="task-status-badge ${task.status}">${task.status.replace("_", " ")}</span>
          <span class="task-priority-badge ${task.priority}">${task.priority}</span>
        </div>
      </div>
    </div>
  `;

  let html = "";

  if (inProgress.length > 0) {
    html += `<div class="task-group-header">In Progress (${inProgress.length})</div>`;
    html += inProgress.map(renderTaskCard).join("");
  }

  if (pending.length > 0) {
    html += `<div class="task-group-header">Pending (${pending.length})</div>`;
    html += pending.map(renderTaskCard).join("");
  }

  if (completed.length > 0) {
    html += `<div class="task-group-header">Completed (${completed.length})</div>`;
    html += completed.map(renderTaskCard).join("");
  }

  taskList.innerHTML = html;

  // Attach click handlers
  taskList.querySelectorAll(".task-card").forEach((card) => {
    const taskId = card.dataset.id;

    card.querySelector('[data-action="toggle"]').onclick = (e) => {
      e.stopPropagation();
      const task = tasksCache.find((t) => t.id === taskId);
      if (task) {
        // Toggle between pending/in_progress/completed
        let newStatus;
        if (task.status === "pending") newStatus = "in_progress";
        else if (task.status === "in_progress") newStatus = "completed";
        else newStatus = "pending";

        socket.emit("task-update", { id: taskId, status: newStatus });
      }
    };

    card.onclick = () => {
      const task = tasksCache.find((t) => t.id === taskId);
      if (task) openTaskEditModal(task);
    };
  });
}

// Open Project Edit Modal
function openProjectEditModal(project = null) {
  if (!projectEditModal) return;

  currentEditingProject = project;
  contextFilesTemp = project?.contextFiles || [];

  if (project) {
    projectEditTitle.textContent = "Edit Project";
    projectNameInput.value = project.name || "";
    projectDirInput.value = project.workingDir || project.working_dir || "";
    projectModelSelect.value = project.model || "opus";
    projectDeleteBtn.classList.remove("hidden");
  } else {
    projectEditTitle.textContent = "New Project";
    projectNameInput.value = "";
    projectDirInput.value = workingDir;
    projectModelSelect.value = "opus";
    projectDeleteBtn.classList.add("hidden");
  }

  renderContextFiles();
  projectEditModal.classList.remove("hidden");
}

// Close Project Edit Modal
function closeProjectEditModalFn() {
  if (projectEditModal) projectEditModal.classList.add("hidden");
  currentEditingProject = null;
  contextFilesTemp = [];
}

// Render Context Files
function renderContextFiles() {
  if (!projectContextFiles) return;

  if (contextFilesTemp.length === 0) {
    projectContextFiles.innerHTML =
      '<div class="context-file-empty">No context files added</div>';
    return;
  }

  projectContextFiles.innerHTML = contextFilesTemp
    .map(
      (file, index) => `
    <div class="context-file-item">
      <span class="context-file-path">${escapeHtml(file)}</span>
      <button class="context-file-remove" data-index="${index}">✕</button>
    </div>
  `,
    )
    .join("");

  // Attach remove handlers
  projectContextFiles
    .querySelectorAll(".context-file-remove")
    .forEach((btn) => {
      btn.onclick = () => {
        const index = parseInt(btn.dataset.index);
        contextFilesTemp.splice(index, 1);
        renderContextFiles();
      };
    });
}

// Save Project
function saveProject() {
  const name = projectNameInput?.value.trim();
  const workingDir = projectDirInput?.value.trim();
  const model = projectModelSelect?.value || "opus";

  if (!name || !workingDir) {
    showToast("Name and working directory are required");
    return;
  }

  if (currentEditingProject) {
    // Update existing project
    socket.emit("project-update", {
      id: currentEditingProject.id,
      name,
      workingDir,
      model,
      contextFiles: contextFilesTemp,
    });
  } else {
    // Create new project
    socket.emit("project-create", {
      name,
      workingDir,
      model,
      contextFiles: contextFilesTemp,
    });
  }

  closeProjectEditModalFn();
}

// Delete Project
function deleteProject() {
  if (!currentEditingProject) return;

  if (
    confirm(
      `Delete project "${currentEditingProject.name}"? This cannot be undone.`,
    )
  ) {
    socket.emit("project-delete", { id: currentEditingProject.id });
    closeProjectEditModalFn();
  }
}

// Open Task Edit Modal
function openTaskEditModal(task = null) {
  if (!taskEditModal) return;

  currentEditingTask = task;

  if (task) {
    taskEditTitle.textContent = "Edit Task";
    taskTitleInput.value = task.title || "";
    taskDescriptionInput.value = task.description || "";
    taskPrioritySelect.value = task.priority || "medium";
    taskStatusSelect.value = task.status || "pending";
    taskStatusGroup.classList.remove("hidden");
    taskDeleteBtn.classList.remove("hidden");
  } else {
    taskEditTitle.textContent = "New Task";
    taskTitleInput.value = "";
    taskDescriptionInput.value = "";
    taskPrioritySelect.value = "medium";
    taskStatusSelect.value = "pending";
    taskStatusGroup.classList.add("hidden");
    taskDeleteBtn.classList.add("hidden");
  }

  taskEditModal.classList.remove("hidden");
}

// Close Task Edit Modal
function closeTaskEditModalFn() {
  if (taskEditModal) taskEditModal.classList.add("hidden");
  currentEditingTask = null;
}

// Save Task
function saveTask() {
  const title = taskTitleInput?.value.trim();
  const description = taskDescriptionInput?.value.trim();
  const priority = taskPrioritySelect?.value || "medium";
  const status = taskStatusSelect?.value || "pending";

  if (!title) {
    showToast("Task title is required");
    return;
  }

  if (currentEditingTask) {
    // Update existing task
    socket.emit("task-update", {
      id: currentEditingTask.id,
      title,
      description,
      priority,
      status,
    });
  } else {
    // Create new task
    if (!activeProjectId) {
      showToast("No project selected");
      return;
    }
    socket.emit("task-create", {
      projectId: activeProjectId,
      title,
      description,
      priority,
    });
  }

  closeTaskEditModalFn();
}

// Delete Task
function deleteTask() {
  if (!currentEditingTask) return;

  if (confirm(`Delete task "${currentEditingTask.title}"?`)) {
    socket.emit("task-delete", { id: currentEditingTask.id });
    closeTaskEditModalFn();
  }
}

// Render Folders List
function renderFoldersList() {
  if (!folderList) return;

  if (!activeProjectId) {
    folderList.innerHTML =
      '<div class="project-empty">Select a project to view folders.</div>';
    return;
  }

  if (foldersCache.length === 0) {
    folderList.innerHTML =
      '<div class="project-empty">No folders yet. Create one to organize conversations.</div>';
    return;
  }

  folderList.innerHTML = foldersCache
    .map(
      (folder) => `
    <div class="folder-card" data-id="${escapeHtml(folder.id)}">
      <span class="folder-icon">📂</span>
      <div class="folder-content">
        <div class="folder-name">${escapeHtml(folder.name)}</div>
        <div class="folder-meta">
          <span>${folder.conversationCount || 0} conversations</span>
        </div>
      </div>
      <div class="folder-card-actions">
        <button class="folder-card-btn" data-action="edit" title="Edit">Edit</button>
      </div>
    </div>
  `,
    )
    .join("");

  // Attach click handlers
  folderList.querySelectorAll(".folder-card").forEach((card) => {
    const folderId = card.dataset.id;

    card.querySelector('[data-action="edit"]').onclick = (e) => {
      e.stopPropagation();
      const folder = foldersCache.find((f) => f.id === folderId);
      if (folder) openFolderEditModal(folder);
    };

    // Clicking card could show conversations in this folder (future feature)
    card.onclick = () => {
      const folder = foldersCache.find((f) => f.id === folderId);
      if (folder) openFolderEditModal(folder);
    };
  });
}

// Open Folder Edit Modal
function openFolderEditModal(folder = null) {
  if (!folderEditModal) return;

  currentEditingFolder = folder;

  if (folder) {
    if (folderEditTitle) folderEditTitle.textContent = "Edit Folder";
    if (folderNameInput) folderNameInput.value = folder.name || "";
    if (folderDeleteBtn) folderDeleteBtn.classList.remove("hidden");
  } else {
    if (folderEditTitle) folderEditTitle.textContent = "New Folder";
    if (folderNameInput) folderNameInput.value = "";
    if (folderDeleteBtn) folderDeleteBtn.classList.add("hidden");
  }

  folderEditModal.classList.remove("hidden");
}

// Close Folder Edit Modal
function closeFolderEditModalFn() {
  if (folderEditModal) folderEditModal.classList.add("hidden");
  currentEditingFolder = null;
}

// Save Folder
function saveFolder() {
  const name = folderNameInput?.value.trim();

  if (!name) {
    showToast("Folder name is required");
    return;
  }

  if (!activeProjectId) {
    showToast("Please select a project first");
    return;
  }

  if (currentEditingFolder) {
    // Update existing folder
    socket.emit("folder-update", {
      id: currentEditingFolder.id,
      name,
    });
  } else {
    // Create new folder
    socket.emit("folder-create", {
      projectId: activeProjectId,
      name,
    });
  }

  closeFolderEditModalFn();
}

// Delete Folder
function deleteFolder() {
  if (!currentEditingFolder) return;

  if (
    confirm(
      `Delete folder "${currentEditingFolder.name}"? Conversations will be moved to the root.`,
    )
  ) {
    socket.emit("folder-delete", { id: currentEditingFolder.id });
    closeFolderEditModalFn();
  }
}

// Setup Project Socket Listeners
function setupProjectSocketListeners() {
  if (!socket || projectListenersSetup) return;
  projectListenersSetup = true;

  socket.on("project-list", (data) => {
    projectsCache = data.projects || [];
    activeProjectId = data.activeId || null;
    renderProjectsList();

    // Update history filter dropdown
    updateHistoryProjectFilter();

    // If on tasks tab and we have an active project, load tasks
    if (projectActiveTab === "tasks" && activeProjectId) {
      loadTasks(activeProjectId);
    }

    // If on folders tab and we have an active project, load folders
    if (projectActiveTab === "folders" && activeProjectId) {
      loadFolders(activeProjectId);
    }
  });

  socket.on("project-created", (data) => {
    if (data.project) {
      projectsCache.push(data.project);
      renderProjectsList();
      updateHistoryProjectFilter();
      showToast(`Project "${data.project.name}" created`);
    }
  });

  socket.on("project-updated", (data) => {
    if (data.project) {
      const index = projectsCache.findIndex((p) => p.id === data.project.id);
      if (index >= 0) {
        projectsCache[index] = data.project;
        renderProjectsList();
      }
      showToast(`Project "${data.project.name}" updated`);
    }
  });

  socket.on("project-deleted", (data) => {
    if (data.id) {
      projectsCache = projectsCache.filter((p) => p.id !== data.id);
      if (activeProjectId === data.id) {
        activeProjectId = null;
      }
      renderProjectsList();
      updateHistoryProjectFilter();
      // Clear filter if the deleted project was selected
      if (historyProjectFilter === data.id) {
        historyProjectFilter = "";
        if (historyProjectFilterSelect) historyProjectFilterSelect.value = "";
        renderConversationList(conversationsCache);
      }
      showToast("Project deleted");
    }
  });

  socket.on("project-activated", (data) => {
    activeProjectId = data.project?.id || null;
    renderProjectsList();
    updateActiveProjectIndicator();

    if (data.project) {
      showToast(`Switched to "${data.project.name}"`);

      // Update working directory to match project
      workingDir =
        data.project.workingDir || data.project.working_dir || workingDir;
      workingDirDisplay.textContent = shortenPath(workingDir);
      localStorage.setItem("claude-web-workingDir", workingDir);
      if (dirInput) dirInput.value = workingDir;

      // Update model to match project
      if (data.project.model) {
        settings.model = data.project.model;
        localStorage.setItem("claude-model", data.project.model);
        const modelSelect = document.getElementById("model-select");
        if (modelSelect) modelSelect.value = data.project.model;
      }

      // Load tasks for the newly active project
      if (projectActiveTab === "tasks") {
        loadTasks(activeProjectId);
      }

      // Load folders for the newly active project
      if (projectActiveTab === "folders") {
        loadFolders(activeProjectId);
      }
    } else {
      showToast("Project deactivated");
      tasksCache = [];
      foldersCache = [];
      renderTasksList();
      renderFoldersList();
    }
  });

  socket.on("project-active", (data) => {
    activeProjectId = data.project?.id || null;
    renderProjectsList(); // Re-render project cards with correct active state
    updateActiveProjectIndicator();

    // Apply project settings on startup (if project is active)
    if (data.project) {
      // Update working directory to match project
      const projectDir = data.project.workingDir || data.project.working_dir;
      if (projectDir) {
        workingDir = projectDir;
        workingDirDisplay.textContent = shortenPath(workingDir);
        localStorage.setItem("claude-web-workingDir", workingDir);
        if (dirInput) dirInput.value = workingDir;
      }

      // Update model to match project
      if (data.project.model) {
        settings.model = data.project.model;
        localStorage.setItem("claude-model", data.project.model);
        const modelSelect = document.getElementById("model-select");
        if (modelSelect) modelSelect.value = data.project.model;
      }
    }
  });

  socket.on("project-error", (data) => {
    console.error("Project error:", data);
    showToast(`Project error: ${data.message}`);
  });

  // Task events
  socket.on("task-list", (data) => {
    tasksCache = data.tasks || [];
    renderTasksList();
  });

  socket.on("task-created", (data) => {
    if (data.task && data.task.projectId === activeProjectId) {
      tasksCache.push(data.task);
      renderTasksList();
      showToast(`Task "${data.task.title}" created`);
    }
    // Refresh project list to update task counts
    loadProjects();
  });

  socket.on("task-updated", (data) => {
    if (data.task) {
      const index = tasksCache.findIndex((t) => t.id === data.task.id);
      if (index >= 0) {
        tasksCache[index] = data.task;
        renderTasksList();
      }
    }
  });

  socket.on("task-deleted", (data) => {
    if (data.id) {
      tasksCache = tasksCache.filter((t) => t.id !== data.id);
      renderTasksList();
      showToast("Task deleted");
    }
    // Refresh project list to update task counts
    loadProjects();
  });

  socket.on("task-error", (data) => {
    console.error("Task error:", data);
    showToast(`Task error: ${data.message}`);
  });

  // Folder events
  socket.on("folder-list", (data) => {
    foldersCache = data.folders || [];
    renderFoldersList();
  });

  socket.on("folder-created", (data) => {
    if (data.folder && data.folder.projectId === activeProjectId) {
      foldersCache.push(data.folder);
      renderFoldersList();
      showToast(`Folder "${data.folder.name}" created`);
    }
  });

  socket.on("folder-updated", (data) => {
    if (data.folder) {
      const index = foldersCache.findIndex((f) => f.id === data.folder.id);
      if (index >= 0) {
        foldersCache[index] = data.folder;
        renderFoldersList();
      }
      showToast(`Folder "${data.folder.name}" updated`);
    }
  });

  socket.on("folder-deleted", (data) => {
    if (data.id) {
      foldersCache = foldersCache.filter((f) => f.id !== data.id);
      renderFoldersList();
      showToast("Folder deleted");
    }
  });

  socket.on("folder-error", (data) => {
    console.error("Folder error:", data);
    showToast(`Folder error: ${data.message}`);
  });

  // Reset flag on disconnect
  socket.on("disconnect", () => {
    projectListenersSetup = false;
  });
}

// Event Handlers - Project Modal
if (projectBtn) {
  projectBtn.onclick = openProjectModal;
}

if (closeProjectModal) {
  closeProjectModal.onclick = closeProjectModalFn;
}

if (projectModal) {
  projectModal.onclick = (e) => {
    if (e.target === projectModal) closeProjectModalFn();
  };
}

if (newProjectBtn) {
  newProjectBtn.onclick = () => openProjectEditModal(null);
}

projectTabs.forEach((tab) => {
  tab.onclick = () => switchProjectTab(tab.dataset.tab);
});

// Event Handlers - Project Edit Modal
if (closeProjectEdit) {
  closeProjectEdit.onclick = closeProjectEditModalFn;
}

if (projectEditBack) {
  projectEditBack.onclick = closeProjectEditModalFn;
}

if (projectEditModal) {
  projectEditModal.onclick = (e) => {
    if (e.target === projectEditModal) closeProjectEditModalFn();
  };
}

if (projectCancelBtn) {
  projectCancelBtn.onclick = closeProjectEditModalFn;
}

if (projectSaveBtn) {
  projectSaveBtn.onclick = saveProject;
}

if (projectDeleteBtn) {
  projectDeleteBtn.onclick = deleteProject;
}

if (addContextFileBtn) {
  addContextFileBtn.onclick = () => {
    const file = prompt("Enter file path (relative to project or absolute):");
    if (file && file.trim()) {
      contextFilesTemp.push(file.trim());
      renderContextFiles();
    }
  };
}

if (projectDirBrowse) {
  projectDirBrowse.onclick = () => {
    // Use current value or working dir as starting point
    const currentPath = projectDirInput.value || workingDir;
    const newPath = prompt("Enter directory path:", currentPath);
    if (newPath && newPath.trim()) {
      projectDirInput.value = newPath.trim();
    }
  };
}

// Event Handlers - Task Edit Modal
if (newTaskBtn) {
  newTaskBtn.onclick = () => {
    if (activeProjectId) {
      openTaskEditModal(null);
    } else {
      showToast("Select a project first");
    }
  };
}

if (closeTaskEdit) {
  closeTaskEdit.onclick = closeTaskEditModalFn;
}

if (taskEditBack) {
  taskEditBack.onclick = closeTaskEditModalFn;
}

if (taskEditModal) {
  taskEditModal.onclick = (e) => {
    if (e.target === taskEditModal) closeTaskEditModalFn();
  };
}

if (taskCancelBtn) {
  taskCancelBtn.onclick = closeTaskEditModalFn;
}

if (taskSaveBtn) {
  taskSaveBtn.onclick = saveTask;
}

if (taskDeleteBtn) {
  taskDeleteBtn.onclick = deleteTask;
}

// Event Handlers - Folder Edit Modal
if (newFolderBtn) {
  newFolderBtn.onclick = () => openFolderEditModal(null);
}

if (closeFolderEdit) {
  closeFolderEdit.onclick = closeFolderEditModalFn;
}

if (folderEditBack) {
  folderEditBack.onclick = closeFolderEditModalFn;
}

if (folderEditModal) {
  folderEditModal.onclick = (e) => {
    if (e.target === folderEditModal) closeFolderEditModalFn();
  };
}

if (folderCancelBtn) {
  folderCancelBtn.onclick = closeFolderEditModalFn;
}

if (folderSaveBtn) {
  folderSaveBtn.onclick = saveFolder;
}

if (folderDeleteBtn) {
  folderDeleteBtn.onclick = deleteFolder;
}

// Keyboard shortcut: Escape closes project modals
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (folderEditModal && !folderEditModal.classList.contains("hidden")) {
      closeFolderEditModalFn();
    } else if (taskEditModal && !taskEditModal.classList.contains("hidden")) {
      closeTaskEditModalFn();
    } else if (
      projectEditModal &&
      !projectEditModal.classList.contains("hidden")
    ) {
      closeProjectEditModalFn();
    } else if (projectModal && !projectModal.classList.contains("hidden")) {
      closeProjectModalFn();
    }
  }
});

// Load active project on connect
function loadActiveProject() {
  if (socket?.connected) {
    socket.emit("project-get-active");
  }
}
