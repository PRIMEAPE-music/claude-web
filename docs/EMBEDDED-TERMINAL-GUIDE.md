# Embedded Terminal Implementation Guide

> Feature: See command/tool output inline with terminal-style rendering

## Overview

Transform the current tool output display from truncated static text into a rich, terminal-style inline view with ANSI color support and optional real-time streaming.

### Current State

- Tools shown in collapsible "tool container"
- Output truncated to 500 chars (`claude-runner.js:72`)
- No ANSI color support
- Output only shown after tool completes

### Target State

- Terminal-style boxes for Bash commands
- Full output with scrollable container
- ANSI color rendering
- Real-time streaming (Phase 4+)
- Works for all tool types, special styling for Bash

---

## File Locations

| File                         | Purpose                                             |
| ---------------------------- | --------------------------------------------------- |
| `claude-runner.js:72`        | `truncateOutput()` function - remove/increase limit |
| `claude-runner.js:206-211`   | `tool_result` event emission                        |
| `public/client.js:1094-1134` | `addToolToContainer()` - tool rendering             |
| `public/client.js:634-676`   | `tool_result` chunk handling                        |
| `public/style.css`           | Tool container styles (search `.tool-item`)         |

---

## Phase 1: Visual Upgrade (Terminal-Style Boxes)

**Goal**: Make Bash tool output look like a terminal

### 1.1 Add CSS for Embedded Terminal

Add to `public/style.css`:

```css
/* Embedded Terminal Styles */
.embedded-terminal {
  background: #1e1e1e;
  border: 1px solid #3c3c3c;
  border-radius: 8px;
  font-family: "JetBrains Mono", "Fira Code", "Consolas", monospace;
  margin: 8px 0;
  overflow: hidden;
}

.term-header {
  background: #2d2d2d;
  padding: 8px 12px;
  border-bottom: 1px solid #3c3c3c;
  display: flex;
  align-items: center;
  gap: 8px;
}

.term-header-dots {
  display: flex;
  gap: 6px;
}

.term-header-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.term-header-dot.red {
  background: #ff5f56;
}
.term-header-dot.yellow {
  background: #ffbd2e;
}
.term-header-dot.green {
  background: #27ca40;
}

.term-header-title {
  color: #808080;
  font-size: 12px;
  flex: 1;
  text-align: center;
}

.term-command {
  background: #252526;
  padding: 8px 12px;
  border-bottom: 1px solid #3c3c3c;
  display: flex;
  align-items: center;
  gap: 8px;
}

.term-prompt {
  color: #4ec9b0;
  font-weight: bold;
}

.term-cmd {
  color: #dcdcdc;
  word-break: break-all;
}

.term-output {
  padding: 12px;
  max-height: 400px;
  overflow-y: auto;
  overflow-x: auto;
  color: #d4d4d4;
  white-space: pre;
  font-size: 13px;
  line-height: 1.4;
  margin: 0;
}

.term-output:empty {
  display: none;
}

.term-output.streaming::after {
  content: "▋";
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.term-footer {
  background: #252526;
  padding: 6px 12px;
  border-top: 1px solid #3c3c3c;
  font-size: 11px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.term-footer.success {
  color: #4ec9b0;
}
.term-footer.error {
  color: #f14c4c;
}
.term-footer.running {
  color: #dcdcaa;
}

.term-footer-status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.term-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #3c3c3c;
  border-top-color: #dcdcaa;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Collapse/expand for long output */
.term-output.collapsed {
  max-height: 150px;
}

.term-expand-btn {
  background: #3c3c3c;
  border: none;
  color: #808080;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
  border-radius: 4px;
}

.term-expand-btn:hover {
  background: #4c4c4c;
  color: #dcdcdc;
}

/* ANSI Color Classes (Phase 3) */
.ansi-black {
  color: #000000;
}
.ansi-red {
  color: #cd3131;
}
.ansi-green {
  color: #0dbc79;
}
.ansi-yellow {
  color: #e5e510;
}
.ansi-blue {
  color: #2472c8;
}
.ansi-magenta {
  color: #bc3fbc;
}
.ansi-cyan {
  color: #11a8cd;
}
.ansi-white {
  color: #e5e5e5;
}
.ansi-bright-black {
  color: #666666;
}
.ansi-bright-red {
  color: #f14c4c;
}
.ansi-bright-green {
  color: #23d18b;
}
.ansi-bright-yellow {
  color: #f5f543;
}
.ansi-bright-blue {
  color: #3b8eea;
}
.ansi-bright-magenta {
  color: #d670d6;
}
.ansi-bright-cyan {
  color: #29b8db;
}
.ansi-bright-white {
  color: #ffffff;
}
.ansi-bold {
  font-weight: bold;
}
.ansi-dim {
  opacity: 0.7;
}
.ansi-italic {
  font-style: italic;
}
.ansi-underline {
  text-decoration: underline;
}
```

### 1.2 Create Terminal Renderer in client.js

Add new function in `public/client.js` (after `addToolToContainer`):

```javascript
// Create embedded terminal for Bash commands
function createEmbeddedTerminal(command, toolId) {
  const terminal = document.createElement("div");
  terminal.className = "embedded-terminal";
  terminal.dataset.toolId = toolId;

  terminal.innerHTML = `
    <div class="term-header">
      <div class="term-header-dots">
        <span class="term-header-dot red"></span>
        <span class="term-header-dot yellow"></span>
        <span class="term-header-dot green"></span>
      </div>
      <span class="term-header-title">Terminal</span>
    </div>
    <div class="term-command">
      <span class="term-prompt">$</span>
      <span class="term-cmd">${escapeHtml(command)}</span>
    </div>
    <pre class="term-output streaming"></pre>
    <div class="term-footer running">
      <span class="term-footer-status">
        <span class="term-spinner"></span>
        <span>Running...</span>
      </span>
      <span class="term-footer-time"></span>
    </div>
  `;

  return terminal;
}

// Update terminal with output
function updateTerminalOutput(terminal, output, isError = false) {
  const outputEl = terminal.querySelector(".term-output");
  if (outputEl) {
    // Phase 3: Replace with ansiToHtml(output)
    outputEl.textContent = output;
    outputEl.classList.remove("streaming");

    // Auto-collapse if output is very long (>20 lines)
    const lineCount = (output.match(/\n/g) || []).length;
    if (lineCount > 20) {
      outputEl.classList.add("collapsed");
      addExpandButton(terminal, outputEl);
    }
  }
}

// Mark terminal as complete
function completeTerminal(terminal, exitCode, durationMs) {
  const footer = terminal.querySelector(".term-footer");
  if (footer) {
    const isSuccess = exitCode === 0;
    footer.className = `term-footer ${isSuccess ? "success" : "error"}`;
    footer.innerHTML = `
      <span class="term-footer-status">
        ${isSuccess ? "✓" : "✗"} Exit ${exitCode}
      </span>
      <span class="term-footer-time">${formatDuration(durationMs)}</span>
    `;
  }
}

// Add expand/collapse button for long output
function addExpandButton(terminal, outputEl) {
  const footer = terminal.querySelector(".term-footer");
  const btn = document.createElement("button");
  btn.className = "term-expand-btn";
  btn.textContent = "Show more";
  btn.onclick = (e) => {
    e.stopPropagation();
    const isCollapsed = outputEl.classList.toggle("collapsed");
    btn.textContent = isCollapsed ? "Show more" : "Show less";
  };
  footer.insertBefore(btn, footer.firstChild);
}

// Format duration nicely
function formatDuration(ms) {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
```

### 1.3 Modify Tool Rendering Logic

Update the `tool_start` handler in `socket.on("response-chunk")` (~line 623):

```javascript
} else if (chunk.type === "tool_start") {
  updateProgressStatus(`Using ${chunk.name}...`);

  if (settings.showTools) {
    // Special handling for Bash tool
    if (chunk.name === "Bash") {
      const command = chunk.input?.command || JSON.stringify(chunk.input);
      const terminal = createEmbeddedTerminal(command, chunk.id);
      const container = getOrCreateToolContainer();
      const body = container.querySelector(".tool-container-body");
      body.appendChild(terminal);
      toolCount++;
      updateToolContainerHeader();
    } else {
      // Regular tool display
      const inputStr = typeof chunk.input === "string"
        ? chunk.input
        : JSON.stringify(chunk.input, null, 2);
      addToolToContainer(chunk.name, inputStr || "(executing...)", chunk.id);
    }
  }
}
```

Update the `tool_result` handler (~line 634):

```javascript
} else if (chunk.type === "tool_result") {
  if (currentToolContainer && settings.showTools) {
    // Check if this is a Bash terminal
    const terminal = currentToolContainer.querySelector(
      `.embedded-terminal[data-tool-id="${chunk.id}"]`
    );

    if (terminal) {
      // Update embedded terminal
      updateTerminalOutput(terminal, chunk.output || '', chunk.isError);
      completeTerminal(terminal, chunk.isError ? 1 : 0, chunk.duration);
    } else {
      // Regular tool result handling
      const toolItem = currentToolContainer.querySelector(
        `.tool-item[data-tool-id="${chunk.id}"]`
      );
      if (toolItem) {
        const content = toolItem.querySelector(".tool-content");
        // ... existing logic
      }
    }
  }
  updateProgressStatus("Processing...");
}
```

---

## Phase 2: Remove Truncation

**Goal**: Show full output instead of truncated 500 chars

### 2.1 Modify claude-runner.js

Change `truncateOutput` function at line 72:

```javascript
// Option A: Remove truncation entirely
function truncateOutput(str, maxLen = Infinity) {
  return str;
}

// Option B: Increase limit significantly
function truncateOutput(str, maxLen = 50000) {
  if (!str || typeof str !== "string") return str;
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `\n... (${str.length - maxLen} more chars)`;
}
```

### 2.2 Add Scrollable Container

Already handled by CSS in Phase 1:

```css
.term-output {
  max-height: 400px;
  overflow-y: auto;
}
```

---

## Phase 3: ANSI Color Support

**Goal**: Render terminal colors properly

### 3.1 Add ansi_up Library

Option A - CDN (add to index.html):

```html
<script src="https://cdn.jsdelivr.net/npm/ansi_up@6.0.2/ansi_up.min.js"></script>
```

Option B - npm:

```bash
npm install ansi_up
```

### 3.2 Create ANSI Parser

Add to `public/client.js`:

```javascript
// Initialize ANSI parser
const ansiUp = new AnsiUp();
ansiUp.use_classes = true; // Use CSS classes instead of inline styles

// Convert ANSI to HTML
function ansiToHtml(text) {
  if (!text) return "";
  return ansiUp.ansi_to_html(text);
}
```

### 3.3 Update Terminal Renderer

Modify `updateTerminalOutput`:

```javascript
function updateTerminalOutput(terminal, output, isError = false) {
  const outputEl = terminal.querySelector(".term-output");
  if (outputEl) {
    // Convert ANSI codes to HTML with color classes
    outputEl.innerHTML = ansiToHtml(output);
    outputEl.classList.remove("streaming");

    // Auto-collapse logic...
  }
}
```

### 3.4 Preserve ANSI in Server

Modify `claude-runner.js` to NOT strip ANSI:

```javascript
// In spawn options, allow colors
const proc = spawn("sh", ["-c", cmd], {
  cwd: workingDir,
  env: { ...process.env, FORCE_COLOR: "1" }, // Changed from "0" to "1"
  stdio: ["ignore", "pipe", "pipe"],
});
```

**Note**: This may require testing - Claude CLI may strip colors regardless.

---

## Phase 4: Real-Time Streaming (Advanced)

**Goal**: See output as it happens, not just at completion

### 4.1 Understanding the Challenge

Claude's `--output-format stream-json` emits:

1. `tool_start` - When tool begins (we get the command)
2. `tool_result` - When tool completes (we get full output)

There's no intermediate streaming of Bash output.

### 4.2 Option A: Parse stderr for Progress

Claude prints progress to stderr. We can intercept:

```javascript
// In claude-runner.js
let currentBashToolId = null;

proc.stderr.on("data", (data) => {
  const text = data.toString();

  // Detect Bash tool starting
  const bashMatch = text.match(/\[Bash\] Running: (.+)/);
  if (bashMatch) {
    currentBashToolId = /* extract from recent tool_start */;
  }

  // Stream partial output
  if (currentBashToolId && !text.startsWith('[')) {
    bufferAndSend({
      type: 'bash_stream',
      toolId: currentBashToolId,
      content: text
    });
  }
});
```

Client handling:

```javascript
} else if (chunk.type === "bash_stream") {
  const terminal = currentToolContainer?.querySelector(
    `.embedded-terminal[data-tool-id="${chunk.toolId}"]`
  );
  if (terminal) {
    const outputEl = terminal.querySelector('.term-output');
    outputEl.innerHTML += ansiToHtml(chunk.content);
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}
```

### 4.3 Option B: Intercept and Re-run Commands

More complex approach - when we detect a Bash tool_start:

1. Extract the command
2. Spawn our own PTY
3. Stream output to client
4. Capture final output for Claude

This requires `node-pty` and careful coordination.

### 4.4 Option C: Use --verbose Flag

The `--verbose` flag may output more intermediate data. Test with:

```bash
claude --print --verbose --output-format stream-json "run ls -la"
```

Check if intermediate Bash output appears.

---

## Phase 5: Full PTY with xterm.js (Advanced)

**Goal**: True terminal emulation with full interactivity

### 5.1 Install Dependencies

```bash
npm install node-pty xterm xterm-addon-fit
```

### 5.2 Server-Side PTY (new file: terminal-service.js)

```javascript
import * as pty from "node-pty";

const terminals = new Map();

export function createTerminal(id, cwd) {
  const shell = process.env.SHELL || "bash";
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: cwd,
    env: process.env,
  });

  terminals.set(id, term);
  return term;
}

export function writeToTerminal(id, data) {
  const term = terminals.get(id);
  if (term) term.write(data);
}

export function resizeTerminal(id, cols, rows) {
  const term = terminals.get(id);
  if (term) term.resize(cols, rows);
}

export function destroyTerminal(id) {
  const term = terminals.get(id);
  if (term) {
    term.kill();
    terminals.delete(id);
  }
}
```

### 5.3 Socket.io Handlers (add to server.js)

```javascript
import {
  createTerminal,
  writeToTerminal,
  resizeTerminal,
  destroyTerminal,
} from "./terminal-service.js";

// In socket connection handler:
socket.on("terminal-create", ({ id, cwd }) => {
  const term = createTerminal(id, cwd);
  term.onData((data) => {
    socket.emit("terminal-data", { id, data });
  });
  term.onExit(({ exitCode }) => {
    socket.emit("terminal-exit", { id, exitCode });
  });
});

socket.on("terminal-input", ({ id, data }) => {
  writeToTerminal(id, data);
});

socket.on("terminal-resize", ({ id, cols, rows }) => {
  resizeTerminal(id, cols, rows);
});

socket.on("terminal-destroy", ({ id }) => {
  destroyTerminal(id);
});
```

### 5.4 Client-Side xterm.js

```html
<!-- Add to index.html -->
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css"
/>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
```

```javascript
// In client.js
function createXtermTerminal(containerId, toolId) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.getElementById(containerId);
  term.open(container);
  fitAddon.fit();

  // Socket handlers
  socket.emit("terminal-create", { id: toolId, cwd: workingDir });

  socket.on("terminal-data", ({ id, data }) => {
    if (id === toolId) term.write(data);
  });

  term.onData((data) => {
    socket.emit("terminal-input", { id: toolId, data });
  });

  return term;
}
```

---

## Testing Checklist

### Phase 1

- [ ] Bash commands show terminal-style box
- [ ] Command is displayed in header
- [ ] Spinner shows while running
- [ ] Exit code shows on completion
- [ ] Other tools still work normally

### Phase 2

- [ ] Long output is not truncated
- [ ] Output container scrolls properly
- [ ] Very long output auto-collapses
- [ ] Expand/collapse button works

### Phase 3

- [ ] Colored output (npm, git, etc.) renders correctly
- [ ] Bold/italic text renders
- [ ] No raw ANSI codes visible

### Phase 4

- [ ] Output streams in real-time
- [ ] No delay waiting for completion
- [ ] Partial output visible during long commands

### Phase 5

- [ ] Full xterm.js terminal works
- [ ] Input possible (if desired)
- [ ] Resize works
- [ ] Terminal cleanup on completion

---

## Rollback Plan

If issues occur, revert by:

1. Remove new CSS classes from style.css
2. Remove terminal functions from client.js
3. Restore original tool rendering in response-chunk handler
4. Restore FORCE_COLOR: "0" in claude-runner.js
5. Restore truncateOutput limit to 500

---

## Future Enhancements

- [ ] Copy button for terminal output
- [ ] Download output as text file
- [ ] Search within terminal output
- [ ] Terminal history (re-run commands)
- [ ] Split pane for multiple terminals
- [ ] Persistent terminal session (not tied to Claude)
