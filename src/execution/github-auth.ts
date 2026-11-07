/**
 * GitHub CLI Authentication Manager
 * Verifies GitHub Pro account is authenticated and Copilot CLI is available
 * Uses gh CLI's built-in authentication (no keys stored in ARC)
 */

import { execSync } from 'child_process';

/**
 * GitHub authentication status
 */
export interface GithubAuthStatus {
  isAuthenticated: boolean;
  user: string;
  version: string;
  scope: string[];
  hostname: string;
}

/**
 * Verify GitHub CLI is installed and authenticated with Copilot support
 * Throws descriptive error if authentication is missing or invalid
 *
 * @returns GitHub authentication status with user info
 * @throws Error if GitHub CLI not installed or not authenticated
 */
export function verifyGithubCopilotAuth(): GithubAuthStatus {
  try {
    // Check if gh CLI is installed and get version
    const versionOutput = execSync('gh --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    // Extract version: "gh version X.X.X (YYYY-MM-DD)"
    const versionMatch = versionOutput.match(/version\s+([\d.]+)/);
    const version = versionMatch?.[1] || 'unknown';

    // Check if authenticated by running 'gh auth status'
    const authOutput = execSync('gh auth status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    // Extract username from output: "Logged in to github.com account username (keyring)"
    const userMatch = authOutput.match(/account\s+([a-zA-Z0-9_-]+)\s+\(/);
    const user = userMatch?.[1] || 'unknown';

    // Extract hostname
    const hostMatch = authOutput.match(/Logged in to\s+(\S+)/);
    const hostname = hostMatch?.[1] || 'github.com';

    // Verify Copilot CLI extension is available
    try {
      execSync('gh copilot -- --version', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      throw new Error(
        'GitHub Copilot CLI unavailable via gh. Check the installed GitHub CLI and Copilot CLI.'
      );
    }

    return {
      isAuthenticated: true,
      user,
      version,
      hostname,
      scope: ['repo', 'read:user'], // Standard GitHub Copilot scopes
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('gh: not found') || errorMessage.includes('command not found')) {
      throw new Error(
        'GitHub CLI not found. Install with:\n' +
        '  macOS: brew install gh\n' +
        '  Linux: apt install gh\n' +
        '  Windows: choco install gh\n' +
        'Then authenticate: gh auth login'
      );
    }

    if (errorMessage.includes('not authenticated') || errorMessage.includes('unauthorized')) {
      throw new Error(
        'GitHub CLI not authenticated. Run: gh auth login\n' +
        'Use your GitHub Pro account for authentication.'
      );
    }

    if (errorMessage.includes('Copilot CLI')) {
      // Re-throw Copilot-specific error
      throw error;
    }

    throw new Error(`GitHub authentication verification failed: ${errorMessage}`);
  }
}

/**
 * Get GitHub auth token for API calls
 * Token is fetched fresh on each call (never cached or stored)
 * Automatically forgotten after use
 *
 * @param hostname - Optional hostname for multi-account support (defaults to github.com)
 * @returns Fresh GitHub API token
 * @throws Error if token cannot be retrieved
 */
export function getGithubToken(hostname: string = 'github.com'): string {
  try {
    const token = execSync(`gh auth token --hostname ${hostname}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!token) {
      throw new Error(`No GitHub token available for ${hostname}`);
    }

    return token;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Failed to retrieve GitHub token for ${hostname}. ` +
      `Ensure you are authenticated: gh auth login\n` +
      `Error: ${errorMessage}`
    );
  }
}

/**
 * Check if GitHub authentication is available without throwing
 * Safe to call during pre-execution checks
 *
 * @returns true if GitHub CLI is installed and authenticated
 */
export function isGithubAuthenticated(): boolean {
  try {
    verifyGithubCopilotAuth();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get human-readable authentication status message
 * Used for progress output and logging
 *
 * @returns Formatted status message
 */
export function getAuthStatusMessage(): string {
  try {
    const status = verifyGithubCopilotAuth();
    return (
      `✅ GitHub Pro authenticated as @${status.user}\n` +
      `   Hostname: ${status.hostname}\n` +
      `   GitHub CLI version: ${status.version}\n` +
      `   Copilot CLI available: Yes`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `❌ GitHub authentication failed:\n${errorMessage}`;
  }
}
