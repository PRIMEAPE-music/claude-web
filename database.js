/**
 * SQLite Database Service for Claude Web
 * Manages projects, tasks, folders, and conversation associations
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";

const HOME = homedir();
const DB_DIR = join(HOME, ".claude");
const DB_PATH = join(DB_DIR, "claude-code.db");

let db = null;

/**
 * Initialize the database and create tables
 */
export async function initDatabase() {
  // Ensure directory exists
  await mkdir(DB_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(`
    -- Projects (presets)
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      model TEXT DEFAULT 'opus',
      context_files TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_accessed TEXT NOT NULL
    );

    -- Tasks (per project)
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Folders (per project, for conversation organization)
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Conversation associations (links existing JSON convos to projects/folders)
    CREATE TABLE IF NOT EXISTS conversation_links (
      conversation_id TEXT PRIMARY KEY,
      project_id TEXT,
      folder_id TEXT,
      linked_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
    );

    -- Settings (key-value store)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_links_project ON conversation_links(project_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_links_folder ON conversation_links(folder_id);
  `);

  console.log(`Database initialized at ${DB_PATH}`);
  return db;
}

/**
 * Get database instance
 */
export function getDb() {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

// ============================================
// Projects CRUD
// ============================================

export function createProject({
  name,
  workingDir,
  model = "opus",
  contextFiles = [],
}) {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO projects (id, name, working_dir, model, context_files, created_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, name, workingDir, model, JSON.stringify(contextFiles), now, now);
  return getProject(id);
}

export function getProject(id) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM projects WHERE id = ?");
  const row = stmt.get(id);
  if (!row) return null;
  return {
    ...row,
    contextFiles: JSON.parse(row.context_files || "[]"),
    workingDir: row.working_dir,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
  };
}

export function listProjects() {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status != 'completed') as active_tasks,
           (SELECT COUNT(*) FROM conversation_links WHERE project_id = p.id) as conversation_count
    FROM projects p
    ORDER BY last_accessed DESC
  `);
  return stmt.all().map((row) => ({
    ...row,
    contextFiles: JSON.parse(row.context_files || "[]"),
    workingDir: row.working_dir,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    activeTasks: row.active_tasks,
    conversationCount: row.conversation_count,
  }));
}

export function updateProject(id, updates) {
  const db = getDb();
  const allowed = ["name", "working_dir", "model", "context_files"];
  const sets = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    const dbKey =
      key === "workingDir"
        ? "working_dir"
        : key === "contextFiles"
          ? "context_files"
          : key;
    if (allowed.includes(dbKey)) {
      sets.push(`${dbKey} = ?`);
      values.push(dbKey === "context_files" ? JSON.stringify(value) : value);
    }
  }

  if (sets.length === 0) return getProject(id);

  sets.push("last_accessed = ?");
  values.push(new Date().toISOString());
  values.push(id);

  const stmt = db.prepare(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`,
  );
  stmt.run(...values);
  return getProject(id);
}

export function deleteProject(id) {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM projects WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

export function touchProject(id) {
  const db = getDb();
  const stmt = db.prepare("UPDATE projects SET last_accessed = ? WHERE id = ?");
  stmt.run(new Date().toISOString(), id);
}

// ============================================
// Active Project (Settings)
// ============================================

export function getActiveProjectId() {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT value FROM settings WHERE key = 'active_project_id'",
  );
  const row = stmt.get();
  return row?.value || null;
}

export function setActiveProjectId(projectId) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES ('active_project_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(projectId);
  if (projectId) {
    touchProject(projectId);
  }
}

export function getActiveProject() {
  const activeId = getActiveProjectId();
  if (!activeId) return null;
  return getProject(activeId);
}

// ============================================
// Tasks CRUD
// ============================================

export function createTask({
  projectId,
  title,
  description = "",
  priority = "medium",
}) {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, status, priority, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `);

  stmt.run(id, projectId, title, description, priority, now);
  return getTask(id);
}

export function getTask(id) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const row = stmt.get(id);
  if (!row) return null;
  return {
    ...row,
    projectId: row.project_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function listTasks(projectId, { status = null } = {}) {
  const db = getDb();
  let query = "SELECT * FROM tasks WHERE project_id = ?";
  const params = [projectId];

  if (status) {
    query += " AND status = ?";
    params.push(status);
  }

  query +=
    " ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, created_at ASC";

  const stmt = db.prepare(query);
  return stmt.all(...params).map((row) => ({
    ...row,
    projectId: row.project_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }));
}

export function updateTask(id, updates) {
  const db = getDb();
  const allowed = ["title", "description", "status", "priority"];
  const sets = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }

  // Auto-set completed_at when status changes to completed
  if (updates.status === "completed") {
    sets.push("completed_at = ?");
    values.push(new Date().toISOString());
  } else if (updates.status && updates.status !== "completed") {
    sets.push("completed_at = NULL");
  }

  if (sets.length === 0) return getTask(id);

  values.push(id);

  const stmt = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`);
  stmt.run(...values);
  return getTask(id);
}

export function deleteTask(id) {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM tasks WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================
// Folders CRUD
// ============================================

export function createFolder({ projectId, name }) {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Get max sort order for this project
  const maxOrder = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM folders WHERE project_id = ?",
    )
    .get(projectId);

  const stmt = db.prepare(`
    INSERT INTO folders (id, project_id, name, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(id, projectId, name, (maxOrder?.max_order ?? -1) + 1, now);
  return getFolder(id);
}

export function getFolder(id) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM folders WHERE id = ?");
  const row = stmt.get(id);
  if (!row) return null;
  return {
    ...row,
    projectId: row.project_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export function listFolders(projectId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM conversation_links WHERE folder_id = f.id) as conversation_count
    FROM folders f
    WHERE f.project_id = ?
    ORDER BY f.sort_order ASC
  `);
  return stmt.all(projectId).map((row) => ({
    ...row,
    projectId: row.project_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    conversationCount: row.conversation_count,
  }));
}

export function updateFolder(id, updates) {
  const db = getDb();
  const allowed = ["name", "sort_order"];
  const sets = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key === "sortOrder" ? "sort_order" : key;
    if (allowed.includes(dbKey)) {
      sets.push(`${dbKey} = ?`);
      values.push(value);
    }
  }

  if (sets.length === 0) return getFolder(id);

  values.push(id);

  const stmt = db.prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id = ?`);
  stmt.run(...values);
  return getFolder(id);
}

export function deleteFolder(id) {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM folders WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================
// Conversation Links
// ============================================

export function linkConversation(conversationId, projectId, folderId = null) {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO conversation_links (conversation_id, project_id, folder_id, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      project_id = excluded.project_id,
      folder_id = excluded.folder_id,
      linked_at = excluded.linked_at
  `);

  stmt.run(conversationId, projectId, folderId, now);
  return getConversationLink(conversationId);
}

export function getConversationLink(conversationId) {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM conversation_links WHERE conversation_id = ?",
  );
  const row = stmt.get(conversationId);
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    projectId: row.project_id,
    folderId: row.folder_id,
    linkedAt: row.linked_at,
  };
}

export function listConversationLinks(projectId, folderId = null) {
  const db = getDb();
  let query = "SELECT * FROM conversation_links WHERE project_id = ?";
  const params = [projectId];

  if (folderId !== null) {
    query += folderId ? " AND folder_id = ?" : " AND folder_id IS NULL";
    if (folderId) params.push(folderId);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params).map((row) => ({
    conversationId: row.conversation_id,
    projectId: row.project_id,
    folderId: row.folder_id,
    linkedAt: row.linked_at,
  }));
}

export function unlinkConversation(conversationId) {
  const db = getDb();
  const stmt = db.prepare(
    "DELETE FROM conversation_links WHERE conversation_id = ?",
  );
  const result = stmt.run(conversationId);
  return result.changes > 0;
}

export function moveConversationToFolder(conversationId, folderId) {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE conversation_links SET folder_id = ? WHERE conversation_id = ?",
  );
  const result = stmt.run(folderId, conversationId);
  return result.changes > 0;
}

// ============================================
// Cleanup
// ============================================

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
