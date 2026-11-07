/**
 * Prompt Cache - Caches deterministic step responses to avoid redundant API calls
 * Strategy: Hash-based cache with 10-minute TTL, gzip compression at rest
 * 
 * Location: ~/.arc/cache/ (created on first use)
 * Format: cache-key.json.gz (gzip-compressed JSON)
 */

import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Cache entry with TTL metadata
 */
interface CacheEntry {
  /** Cached response from gh copilot */
  response: string;
  /** Timestamp when cached (ms since epoch) */
  timestamp: number;
  /** TTL in milliseconds (default: 10 minutes = 600000ms) */
  ttl: number;
  /** Hash of the cache key for validation */
  keyHash: string;
}

/**
 * Generate cache key from prompt, agent, and model
 * Uses SHA256 hash for compact representation
 * 
 * @param prompt - Prompt text
 * @param agent - Agent type ('suggest', 'explain', 'edit')
 * @param model - Model selection ('haiku', 'sonnet')
 * @returns Hex string cache key (64 chars)
 */
export function generateCacheKey(
  prompt: string,
  agent: string,
  model: 'haiku' | 'sonnet'
): string {
  const combined = `${prompt}|${agent}|${model}`;
  return createHash('sha256').update(combined).digest('hex');
}

/**
 * Get cache directory path
 * Creates directory if it doesn't exist
 * 
 * @returns Full path to cache directory
 */
async function getCacheDir(): Promise<string> {
  const cacheDir = join(homedir(), '.arc', 'cache');

  if (!existsSync(cacheDir)) {
    await mkdir(cacheDir, { recursive: true });
  }

  return cacheDir;
}

/**
 * Get cache file path for a key
 * 
 * @param cacheKey - Cache key from generateCacheKey()
 * @returns Full path to cache file
 */
async function getCacheFilePath(cacheKey: string): Promise<string> {
  const cacheDir = await getCacheDir();
  return join(cacheDir, `${cacheKey}.json`);
}

/**
 * Check if cache entry is still valid (not expired)
 * 
 * @param entry - Cache entry to check
 * @returns true if entry is within TTL, false if expired
 */
function isCacheValid(entry: CacheEntry): boolean {
  const now = Date.now();
  const age = now - entry.timestamp;
  return age < entry.ttl;
}

/**
 * Get cached response if available and valid
 * Returns null if cache miss or expired
 * 
 * @param prompt - Prompt text
 * @param agent - Agent type
 * @param model - Model selection
 * @returns Cached response string, or null if no valid cache
 */
export async function getCachedResponse(
  prompt: string,
  agent: string,
  model: 'haiku' | 'sonnet'
): Promise<string | null> {
  try {
    const cacheKey = generateCacheKey(prompt, agent, model);
    const filePath = await getCacheFilePath(cacheKey);

    // Check if cache file exists
    if (!existsSync(filePath)) {
      return null;
    }

    // Read cache file
    const data = await readFile(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(data);

    // Validate cache key hash
    if (entry.keyHash !== cacheKey) {
      console.warn(`⚠️  Cache key mismatch for ${cacheKey}, invalidating`);
      return null;
    }

    // Check if expired
    if (!isCacheValid(entry)) {
      return null; // Cache expired
    }

    // Cache hit!
    return entry.response;
  } catch (error) {
    // Any error reading cache = cache miss
    return null;
  }
}

/**
 * Store response in cache
 * 
 * @param prompt - Prompt text
 * @param agent - Agent type
 * @param model - Model selection
 * @param response - Response from gh copilot to cache
 * @param ttlMs - TTL in milliseconds (default: 10 minutes)
 */
export async function setCachedResponse(
  prompt: string,
  agent: string,
  model: 'haiku' | 'sonnet',
  response: string,
  ttlMs: number = 600000 // 10 minutes default
): Promise<void> {
  try {
    const cacheKey = generateCacheKey(prompt, agent, model);
    const filePath = await getCacheFilePath(cacheKey);

    const entry: CacheEntry = {
      response,
      timestamp: Date.now(),
      ttl: ttlMs,
      keyHash: cacheKey,
    };

    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  } catch (error) {
    // Silently fail cache writes - don't block execution
    console.debug(`⚠️  Failed to cache response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Clear all cache entries
 * Used for testing or manual cache reset
 */
export async function clearCache(): Promise<void> {
  try {
    const cacheDir = await getCacheDir();

    // Read all files in cache directory
    const files = await (await import('fs/promises')).readdir(cacheDir);

    // Delete each cache file
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = join(cacheDir, file);
        await (await import('fs/promises')).unlink(filePath);
      }
    }

    console.log('✅ Cache cleared');
  } catch (error) {
    console.error(`Failed to clear cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get cache statistics
 * Returns count and total size of cached entries
 */
export async function getCacheStats(): Promise<{ count: number; totalSizeBytes: number }> {
  try {
    const cacheDir = await getCacheDir();

    if (!existsSync(cacheDir)) {
      return { count: 0, totalSizeBytes: 0 };
    }

    const files = await (await import('fs/promises')).readdir(cacheDir);
    let totalSize = 0;

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = join(cacheDir, file);
        const stats = await (await import('fs/promises')).stat(filePath);
        totalSize += stats.size;
      }
    }

    return {
      count: files.length,
      totalSizeBytes: totalSize,
    };
  } catch (error) {
    return { count: 0, totalSizeBytes: 0 };
  }
}

/**
 * Format cache stats for display
 * 
 * @param stats - Cache statistics from getCacheStats()
 * @returns Formatted string for logging
 */
export function formatCacheStats(stats: { count: number; totalSizeBytes: number }): string {
  const sizeKB = (stats.totalSizeBytes / 1024).toFixed(1);
  return `${stats.count} cached entries, ${sizeKB}KB total`;
}
