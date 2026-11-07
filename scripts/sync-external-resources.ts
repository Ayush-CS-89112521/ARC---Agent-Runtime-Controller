
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Sync External Resources Script
 * 
 * 1. Updates git submodules (mcp_servers, public_api)
 * 2. Regenerates MCP Catalog
 * 3. Regenerates API Registry
 * 4. Reports changes
 */

function runCommand(command: string, cwd: string = process.cwd(), ignoreError: boolean = false): string {
    try {
        return execSync(command, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch (error) {
        if (!ignoreError) {
            console.error(`❌ Command failed: ${command}`);
            if (error instanceof Error) {
                // @ts-ignore
                if (error.stderr) console.error(error.stderr.toString());
            }
        }
        throw error;
    }
}

function isGitRepository(cwd: string): boolean {
    try {
        runCommand('git rev-parse --is-inside-work-tree', cwd, true);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    console.log('🔄 Syncing external resources...\n');
    const rootDir = process.cwd();

    try {
        // 1. Update Submodules
        console.log('📦 Updating git submodules...');
        if (isGitRepository(rootDir) && existsSync(join(rootDir, '.gitmodules'))) {
            runCommand('git submodule update --init --recursive --remote');
            console.log('✅ Submodules updated.');
        } else {
            console.log('⚠️ Skipping submodule update (not a git repo or no .gitmodules).');
        }

        // 2. Regenerate MCP Catalog
        console.log('\n🛠️ Regenerating MCP Catalog...');
        runCommand('bun run scripts/parse-mcp-servers.ts');

        // 3. Regenerate API Registry
        console.log('\n📡 Regenerating API Registry...');
        runCommand('bun run scripts/parse-public-apis.ts');

        // 4. Check for changes
        console.log('\n🔍 Checking for changes...');

        if (isGitRepository(rootDir)) {
            const status = runCommand('git status --porcelain data/');
            if (status) {
                console.log('📝 Changes detected in catalogs:');
                console.log(status);

                // Setup for GitHub Actions to commit
                if (process.env.CI) {
                    console.log('\n🤖 CI environment detected. Configuring git...');
                    runCommand('git config --global user.name "github-actions[bot]"');
                    runCommand('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
                }
            } else {
                console.log('✨ No changes detected. Catalogs are up to date.');
            }
        } else {
            console.log('⚠️ Not a git repository. Skipping change detection.');
            console.log('✨ Catalogs regenerated successfully.');
        }



        console.log('\n✅ Sync process completed successfully!');

    } catch (error) {
        console.error('\n❌ Sync failed:', error);
        process.exit(1);
    }
}

main();
