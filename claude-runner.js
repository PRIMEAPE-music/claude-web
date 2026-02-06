import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  unlink,
  access,
} from "fs/promises";
import { join, extname } from "path";
import { homedir } from "os";
import { constants } from "fs";

const sessions = new Map();
const SESSIONS_DIR = join(homedir(), ".claude", "claude-web", "sessions");

// Shared browser WS endpoint (set by server.js when shared browser is active)
let globalBrowserWSEndpoint = null;

export function setBrowserWSEndpoint(wsEndpoint) {
  globalBrowserWSEndpoint = wsEndpoint;
}

// Validate UUID format for session IDs
function isValidUUID(id) {
  if (!id || typeof id !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

// Ensure sessions directory exists
mkdir(SESSIONS_DIR, { recursive: true }).catch(() => {});

export function createSession(workingDir = process.env.HOME, model = "opus") {
  const sessionId = uuidv4();
  sessions.set(sessionId, {
    id: sessionId,
    workingDir,
    model, // claude model: opus, sonnet, haiku
    process: null,
    history: [],
    // Response buffer for when client disconnects mid-response
    responseBuffer: [],
    isBuffering: false,
    bufferComplete: false,
    // Agent tracking
    activeAgents: new Map(), // tool_use_id -> agent info
  });
  return sessionId;
}

export function setSessionModel(sessionId, model) {
  const session = sessions.get(sessionId);
  if (session) {
    session.model = model;
  }
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

// Check if directory exists and is accessible
async function directoryExists(dir) {
  try {
    await access(dir, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Escape string for shell
function shellEscape(str) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// Truncate long tool output for display (increased limit for embedded terminal)
function truncateOutput(str, maxLen = 50000) {
  if (!str || typeof str !== "string") return str;
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `\n... (${str.length - maxLen} more chars)`;
}

export async function runClaudeCommand(
  sessionId,
  prompt,
  imagePaths,
  onData,
  onEnd,
  onError,
) {
  const session = sessions.get(sessionId);
  if (!session) {
    onError(new Error("Session not found"));
    return null;
  }

  // Kill any existing process for this session
  if (session.process) {
    session.process.kill();
  }

  // Validate working directory exists, fall back to HOME if not
  let workingDir = session.workingDir;
  if (!(await directoryExists(workingDir))) {
    console.warn(
      `Working directory does not exist: ${workingDir}, falling back to HOME`,
    );
    workingDir = homedir();
  }

  // Build command string - use stream-json for real-time token streaming
  // Note: stream-json requires --verbose when used with --print
  // --include-partial-messages ensures agent/Task tool output is streamed
  // --input-format stream-json enables native image support via stdin
  let cmd =
    "claude --print --verbose --output-format stream-json --input-format stream-json --include-partial-messages --dangerously-skip-permissions";

  // Add model selection if specified
  if (session.model) {
    cmd += ` --model ${session.model}`;
  }

  // Resume session if we have history
  if (session.history.length > 0 && session.claudeSessionId) {
    cmd += ` --resume ${session.claudeSessionId}`;
  }

  // Build message content blocks for stream-json input
  const contentBlocks = [];

  // If images are provided, read them and add as native image content blocks
  if (imagePaths && imagePaths.length > 0) {
    for (const imgPath of imagePaths) {
      try {
        const imgData = await readFile(imgPath);
        const base64Data = imgData.toString("base64");
        const ext = extname(imgPath).toLowerCase().replace(".", "");
        const mediaTypes = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
        };
        const mediaType = mediaTypes[ext] || "image/png";
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: base64Data },
        });
      } catch (err) {
        console.warn(`Failed to read image ${imgPath}: ${err.message}`);
      }
    }
  }

  // Add the text prompt
  contentBlocks.push({ type: "text", text: prompt || "What do you see?" });

  // Build the stream-json input message
  const inputMessage = JSON.stringify({
    type: "user",
    message: { role: "user", content: contentBlocks },
  });

  console.log(
    `Running command: ${cmd.substring(0, 100)}... (${contentBlocks.length} content blocks)`,
  );
  console.log(`Working directory: ${workingDir}`);

  // Build env, optionally passing shared browser WS endpoint
  const env = { ...process.env, FORCE_COLOR: "0" };
  if (globalBrowserWSEndpoint) {
    env.PUPPETEER_BROWSER_WS_ENDPOINT = globalBrowserWSEndpoint;
  }

  const proc = spawn("sh", ["-c", cmd], {
    cwd: workingDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  console.log(`Claude process started with PID: ${proc.pid}`);

  // Write the message via stdin (stream-json input format) and close stdin
  proc.stdin.write(inputMessage + "\n");
  proc.stdin.end();

  session.process = proc;
  session.history.push({ role: "user", content: prompt });

  // Reset and start buffering
  session.responseBuffer = [];
  session.isBuffering = true;
  session.bufferComplete = false;

  let buffer = "";
  let fullResponse = "";

  // Wrapper to buffer all chunks
  const bufferAndSend = (chunk) => {
    session.responseBuffer.push(chunk);
    onData(chunk);
  };

  proc.stdout.on("data", (data) => {
    buffer += data.toString();

    // Process complete lines (stream-json is newline-delimited)
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Handle assistant message - contains the response text
        if (event.type === "assistant" && event.message) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                fullResponse += block.text;
                bufferAndSend({ type: "text", content: block.text });
              } else if (block.type === "tool_use") {
                bufferAndSend({
                  type: "tool_start",
                  name: block.name,
                  id: block.id,
                  input: block.input,
                });
                // Detect agent spawns (Task tool with subagent_type)
                if (block.name === "Task" && block.input?.subagent_type) {
                  const agentInfo = {
                    id: block.id,
                    type: block.input.subagent_type,
                    description:
                      block.input.description || block.input.subagent_type,
                    prompt: block.input.prompt,
                    status: "running",
                    startedAt: Date.now(),
                  };
                  session.activeAgents.set(block.id, agentInfo);
                  bufferAndSend({
                    type: "agent_spawned",
                    agent: agentInfo,
                    activeCount: session.activeAgents.size,
                  });
                }

                // Detect Claude's puppeteer/browser tool usage
                const PUPPETEER_TOOL_MAP = {
                  puppeteer_navigate: "navigate",
                  puppeteer_screenshot: "screenshot",
                  puppeteer_click: "click",
                  puppeteer_fill: "fill",
                  puppeteer_evaluate: "evaluate",
                  puppeteer_hover: "hover",
                  puppeteer_select: "select",
                  mcp__puppeteer__puppeteer_navigate: "navigate",
                  mcp__puppeteer__puppeteer_screenshot: "screenshot",
                  mcp__puppeteer__puppeteer_click: "click",
                  mcp__puppeteer__puppeteer_fill: "fill",
                  mcp__puppeteer__puppeteer_evaluate: "evaluate",
                  mcp__puppeteer__puppeteer_hover: "hover",
                  mcp__puppeteer__puppeteer_select: "select",
                };
                const browserAction = PUPPETEER_TOOL_MAP[block.name];
                if (browserAction) {
                  bufferAndSend({
                    type: "browser_action",
                    source: "claude",
                    action: browserAction,
                    toolName: block.name,
                    input: block.input || {},
                    id: block.id,
                  });
                }
              }
            }
          }
          // Extract session ID
          if (event.session_id) {
            session.claudeSessionId = event.session_id;
          }
        }

        // Handle tool results (comes as "user" type with tool_result content)
        if (event.type === "user" && event.message?.content) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                bufferAndSend({
                  type: "tool_result",
                  id: block.tool_use_id,
                  output: truncateOutput(block.content),
                  isError: block.is_error,
                });
                // Check if this completes an agent
                const agent = session.activeAgents.get(block.tool_use_id);
                if (agent) {
                  agent.status = block.is_error ? "error" : "completed";
                  agent.completedAt = Date.now();
                  agent.duration = agent.completedAt - agent.startedAt;
                  agent.result = truncateOutput(block.content, 500); // Short preview
                  agent.isError = block.is_error;
                  session.activeAgents.delete(block.tool_use_id);
                  bufferAndSend({
                    type: "agent_completed",
                    agent: agent,
                    activeCount: session.activeAgents.size,
                  });
                }
              }
            }
          }
        }

        // Extract session ID and stats from result event
        if (event.type === "result") {
          if (event.session_id) {
            session.claudeSessionId = event.session_id;
          }
          // Send cost and usage stats
          bufferAndSend({
            type: "stats",
            cost: event.total_cost_usd || 0,
            duration: event.duration_ms || 0,
            turns: event.num_turns || 1,
            usage: event.usage || {},
          });
        }
      } catch (e) {
        // Ignore parse errors for incomplete JSON
      }
    }
  });

  proc.stderr.on("data", (data) => {
    const text = data.toString();
    console.log(`[stderr] ${text}`);
  });

  proc.on("close", (code) => {
    console.log(
      `Claude process closed with code: ${code}, response length: ${fullResponse.length}`,
    );
    session.process = null;

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === "result" && event.session_id) {
          session.claudeSessionId = event.session_id;
        }
        // Extract any final text from assistant message
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              fullResponse += block.text;
              bufferAndSend({ type: "text", content: block.text });
            }
          }
        }
      } catch (e) {
        // If buffer isn't valid JSON and we have no response, treat as error
        if (!fullResponse && buffer.trim()) {
          bufferAndSend({ type: "error", content: buffer.trim() });
        }
      }
    }

    // Store the full response in history
    if (fullResponse) {
      session.history.push({ role: "assistant", content: fullResponse });
    }

    // Mark buffer as complete
    session.isBuffering = false;
    session.bufferComplete = true;

    // Persist session state after each message
    saveSession(sessionId);

    // Handle non-zero exit with no response
    if (code !== 0 && !fullResponse) {
      bufferAndSend({
        type: "error",
        content: "Claude process exited with an error",
      });
    }

    onEnd(code);
  });

  proc.on("error", (err) => {
    console.error(`Process error: ${err.message}`);
    session.process = null;
    onError(err);
  });

  return proc;
}

export function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session?.process) {
    session.process.kill();
    session.process = null;
  }
}

export function deleteSession(sessionId) {
  // Validate session ID to prevent path traversal
  if (!isValidUUID(sessionId)) return;
  stopSession(sessionId);
  sessions.delete(sessionId);
  // Remove persisted session file
  unlink(join(SESSIONS_DIR, `${sessionId}.json`)).catch(() => {});
}

// Get buffered response chunks for a session (for reconnection)
export function getBufferedResponse(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  return {
    chunks: session.responseBuffer || [],
    isComplete: session.bufferComplete || false,
    isBuffering: session.isBuffering || false,
  };
}

// Clear the response buffer after client has received it
export function clearBuffer(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.responseBuffer = [];
    session.bufferComplete = false;
    session.isBuffering = false;
  }
}

// Save session state to disk
async function saveSession(sessionId) {
  // Validate session ID to prevent path traversal
  if (!isValidUUID(sessionId)) return;
  const session = sessions.get(sessionId);
  if (!session) return;

  const data = {
    id: session.id,
    workingDir: session.workingDir,
    claudeSessionId: session.claudeSessionId || null,
    history: session.history,
    updatedAt: new Date().toISOString(),
  };

  try {
    await writeFile(
      join(SESSIONS_DIR, `${sessionId}.json`),
      JSON.stringify(data, null, 2),
    );
  } catch (err) {
    console.error(`Failed to save session ${sessionId}:`, err.message);
  }
}

// Load all persisted sessions on startup
export async function loadPersistedSessions() {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const files = await readdir(SESSIONS_DIR);
    let loaded = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = await readFile(join(SESSIONS_DIR, file), "utf-8");
        const data = JSON.parse(content);

        // Restore session to memory (without active process)
        sessions.set(data.id, {
          id: data.id,
          workingDir: data.workingDir,
          process: null,
          history: data.history || [],
          claudeSessionId: data.claudeSessionId,
          activeAgents: new Map(),
        });
        loaded++;
      } catch (e) {
        console.error(`Failed to load session from ${file}:`, e.message);
      }
    }

    console.log(`Loaded ${loaded} persisted sessions`);
    return loaded;
  } catch (err) {
    console.error("Failed to load persisted sessions:", err.message);
    return 0;
  }
}

// Get list of available sessions (for client to choose from)
export async function listSessions() {
  const sessionList = [];

  for (const [id, session] of sessions) {
    sessionList.push({
      id,
      workingDir: session.workingDir,
      messageCount: session.history.length,
      hasClaudeSession: !!session.claudeSessionId,
      isActive: !!session.process,
    });
  }

  return sessionList;
}

// Restore a session by ID (returns the session or null)
export function restoreSession(sessionId) {
  return sessions.get(sessionId) || null;
}
