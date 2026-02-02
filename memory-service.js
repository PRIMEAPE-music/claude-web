/**
 * Memory Service - High-level wrapper for MCP memory operations
 * MVP: Read-only operations (readGraph, searchNodes)
 */

import { getMemoryClient, disconnectMemoryClient } from "./mcp-client.js";

// Cache configuration
const CACHE_TTL_MS = 30000; // 30 seconds

// Input validation limits
const MAX_QUERY_LENGTH = 1000;
const MAX_ENTITY_NAME_LENGTH = 500;

// Cache storage
let graphCache = null;
let graphCacheTime = 0;

/**
 * Read the entire knowledge graph (entities + relations)
 * Implements 30-second caching for performance
 * @param {boolean} forceRefresh - Bypass cache and fetch fresh data
 * @returns {Promise<{entities: Array, relations: Array}>}
 */
export async function readGraph(forceRefresh = false) {
  const now = Date.now();

  // Check cache validity
  if (!forceRefresh && graphCache && now - graphCacheTime < CACHE_TTL_MS) {
    console.log("[MemoryService] Returning cached graph");
    return graphCache;
  }

  console.log("[MemoryService] Fetching graph from MCP server");
  const client = getMemoryClient();

  try {
    const result = await client.callTool("read_graph", {});

    // Normalize result structure
    const graph = {
      entities: result?.entities || [],
      relations: result?.relations || [],
    };

    // Update cache
    graphCache = graph;
    graphCacheTime = now;

    console.log(
      `[MemoryService] Loaded ${graph.entities.length} entities, ${graph.relations.length} relations`,
    );
    return graph;
  } catch (err) {
    console.error("[MemoryService] Failed to read graph:", err.message);
    // Return cached data if available, even if stale
    if (graphCache) {
      console.log("[MemoryService] Returning stale cache due to error");
      return graphCache;
    }
    throw err;
  }
}

/**
 * Search nodes in the knowledge graph
 * @param {string} query - Search query
 * @returns {Promise<{entities: Array}>}
 */
export async function searchNodes(query) {
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return { entities: [] };
  }

  // Validate query length to prevent DoS
  const trimmedQuery = query.trim().substring(0, MAX_QUERY_LENGTH);

  console.log(`[MemoryService] Searching for: ${trimmedQuery}`);
  const client = getMemoryClient();

  try {
    const result = await client.callTool("search_nodes", {
      query: trimmedQuery,
    });

    // Normalize result structure
    const entities = result?.entities || (Array.isArray(result) ? result : []);

    console.log(`[MemoryService] Found ${entities.length} matching entities`);
    return { entities };
  } catch (err) {
    console.error("[MemoryService] Search failed:", err.message);
    throw err;
  }
}

/**
 * Get a specific entity by name (opens it from the graph)
 * @param {string} name - Entity name
 * @returns {Promise<object|null>}
 */
export async function getEntity(name) {
  if (!name || typeof name !== "string") {
    return null;
  }

  // Validate name length to prevent resource exhaustion
  const trimmedName = name.trim().substring(0, MAX_ENTITY_NAME_LENGTH);
  if (trimmedName.length === 0) {
    return null;
  }

  console.log(`[MemoryService] Getting entity: ${trimmedName}`);
  const client = getMemoryClient();

  try {
    const result = await client.callTool("open_nodes", {
      names: [trimmedName],
    });

    // Extract entity from result
    const entities = result?.entities || (Array.isArray(result) ? result : []);
    return entities.find((e) => e.name === trimmedName) || null;
  } catch (err) {
    console.error("[MemoryService] Failed to get entity:", err.message);
    throw err;
  }
}

/**
 * Invalidate the graph cache
 * Call this after any write operations
 */
export function invalidateCache() {
  graphCache = null;
  graphCacheTime = 0;
  console.log("[MemoryService] Cache invalidated");
}

/**
 * Get cache status (for debugging)
 * @returns {{cached: boolean, age: number, ttl: number}}
 */
export function getCacheStatus() {
  const now = Date.now();
  const age = graphCache ? now - graphCacheTime : 0;
  return {
    cached: graphCache !== null,
    age,
    ttl: CACHE_TTL_MS,
    stale: age > CACHE_TTL_MS,
  };
}

/**
 * Cleanup - disconnect the MCP client
 */
export function cleanup() {
  invalidateCache();
  disconnectMemoryClient();
  console.log("[MemoryService] Cleaned up");
}

// Handle process exit
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

export default {
  readGraph,
  searchNodes,
  getEntity,
  invalidateCache,
  getCacheStatus,
  cleanup,
};
