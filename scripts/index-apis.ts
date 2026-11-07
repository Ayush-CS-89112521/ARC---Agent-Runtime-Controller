#!/usr/bin/env bun
/**
 * Dynamic Tool Registry Indexer
 * 
 * Parses .data/public_api/README.md and generates data/api-registry.json
 * with type-safe, searchable indexes for ARC integration.
 * 
 * Usage: bun run scripts/index-apis.ts [--validate-links]
 */

import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────

interface ApiEntry {
  id: string;                    // Unique slug: 'stripe'
  name: string;                  // Display name: 'Stripe'
  url: string;                   // Documentation URL
  category: string;              // Category key: 'finance'
  description: string;           // Short description
  domain: string;                // Base domain: 'stripe.com'
  authType: 'none' | 'apiKey' | 'oauth' | 'other';
  https: boolean;
  cors: 'yes' | 'no' | 'unknown';
  protocols?: string[];
  validated?: boolean;
  validatedAt?: string;
  validationStatus?: 'working' | 'cloudflare_protected' | 'dead' | 'timeout';
  source: string;
  lastUpdated: string;
}

interface ApiRegistry {
  version: string;
  lastUpdated: string;
  source: string;
  entries: ApiEntry[];
  indexes: {
    byDomain: Record<string, ApiEntry[]>;
    byCategory: Record<string, ApiEntry[]>;
    byAuthType: Record<string, ApiEntry[]>;
    byName: Record<string, ApiEntry>;
    byTag: Record<string, ApiEntry[]>;
  };
  statistics: {
    totalApis: number;
    categoriesCount: number;
    authTypeDistribution: Record<string, number>;
    validationStats: {
      validated: number;
      working: number;
      dead: number;
    };
  };
}

// ─────────────────────────────────────────────────────────────────
// PARSER UTILITIES
// ─────────────────────────────────────────────────────────────────

/**
 * Parse category name from markdown header
 * Input: "### Finance"
 * Output: { level: 3, name: "Finance", key: "finance" }
 */
function parseCategory(line: string): { level: number; name: string; key: string } | null {
  const match = line.match(/^(#{2,4})\s+(.+)$/);
  if (!match) return null;

  const level = match[1].length;
  const name = match[2];
  const key = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  return { level, name, key };
}

/**
 * Parse markdown table row
 * Input: "| [Name](url) | Desc | `auth` | Yes | Yes |"
 * Output: { name, url, description, auth, https, cors }
 */
function parseTableRow(line: string): {
  name: string;
  url: string;
  description: string;
  auth: string;
  https: string;
  cors: string;
} | null {
  // Split by pipe, trim whitespace
  const parts = line.split('|').map(p => p.trim()).filter(p => p);

  if (parts.length < 5) return null;

  // Extract markdown link: [Name](url)
  const linkMatch = parts[0].match(/^\[(.+?)\]\((.+?)\)$/);
  if (!linkMatch) return null;

  const [, name, url] = linkMatch;

  // Validate URL
  if (!url.startsWith('http')) return null;

  const description = parts[1];
  const auth = parts[2];
  const https = parts[3];
  const cors = parts[4];

  // Validate required fields
  if (!description || !auth || !https || !cors) return null;

  return { name, url, description, auth, https, cors };
}

/**
 * Normalize auth type
 * Input: "`apiKey`", "No", "OAuth"
 * Output: "apiKey", "none", "oauth"
 */
function normalizeAuthType(auth: string): 'none' | 'apiKey' | 'oauth' | 'other' {
  const normalized = auth.toLowerCase().trim().replace(/`/g, '');

  if (normalized === 'no') return 'none';
  if (normalized === 'apikey') return 'apiKey';
  if (normalized === 'oauth') return 'oauth';
  if (normalized.includes('mashape')) return 'other';
  if (normalized.includes('user-agent')) return 'other';

  return 'other';
}

/**
 * Extract domain from URL
 * Input: "https://stripe.com/docs"
 * Output: "stripe.com"
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Generate unique slug for API
 * Input: "Stripe"
 * Output: "stripe"
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate tags based on API metadata
 * Input: { name: "Stripe", description: "Payment processing", category: "finance" }
 * Output: ["payment", "payment-processing", "finance"]
 */
function generateTags(name: string, description: string, category: string): string[] {
  const tags = new Set<string>();

  // Add category
  tags.add(category);

  // Extract keywords from description
  const keywords = description
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'from'].includes(w));

  keywords.forEach(kw => {
    if (kw.length > 2) tags.add(kw);
  });

  // Add name tokens
  const nameTokens = name.toLowerCase().split(/[-\s]/);
  nameTokens.forEach(token => {
    if (token.length > 2) tags.add(token);
  });

  // Common category-based tags
  const categoryTags: Record<string, string[]> = {
    'finance': ['payment', 'stock', 'crypto', 'forex', 'trading'],
    'authentication': ['auth', 'oauth', 'jwt', 'identity'],
    'machine-learning': ['ai', 'ml', 'prediction', 'nlp'],
    'security': ['scan', 'threat', 'vulnerability', 'malware'],
  };

  if (categoryTags[category]) {
    categoryTags[category].forEach(tag => {
      if (description.toLowerCase().includes(tag)) {
        tags.add(tag);
      }
    });
  }

  return Array.from(tags);
}

/**
 * Validate API entry
 * Returns error message if invalid, null if valid
 */
function validateEntry(entry: Partial<ApiEntry>): string | null {
  if (!entry.name) return 'Missing name';
  if (!entry.url) return `${entry.name}: Missing URL`;
  if (!entry.category) return `${entry.name}: Missing category`;
  if (!entry.description) return `${entry.name}: Missing description`;
  if (!entry.domain) return `${entry.name}: Invalid domain`;
  if (!entry.authType) return `${entry.name}: Invalid auth type`;
  if (entry.description.length > 100) return `${entry.name}: Description too long`;

  return null;
}

// ─────────────────────────────────────────────────────────────────
// MAIN PARSER
// ─────────────────────────────────────────────────────────────────

async function indexApis(): Promise<void> {
  console.log('📚 Starting API Registry Indexing...\n');

  const readmeFile = path.join(process.cwd(), '.data', 'public_api', 'README.md');

  if (!fs.existsSync(readmeFile)) {
    console.error(`❌ README.md not found at: ${readmeFile}`);
    process.exit(1);
  }

  console.log(`📖 Reading ${readmeFile}...`);
  const content = fs.readFileSync(readmeFile, 'utf-8');
  const lines = content.split('\n');

  const entries: ApiEntry[] = [];
  const seenDomains = new Set<string>();
  let currentCategory = '';
  let inTable = false;
  let errors: string[] = [];
  let warnings: string[] = [];

  // Parse line by line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect category headers
    const category = parseCategory(line);
    if (category && category.level === 3) {
      currentCategory = category.key;
      inTable = false;
      continue;
    }

    // Skip non-table content
    if (!line.includes('|')) continue;

    // Detect table start (header row with :--- separators)
    if (line.includes(':---') || line.match(/^\|\s*API\s*\|/i)) {
      inTable = true;
      continue;
    }

    // Parse table rows
    if (inTable && currentCategory) {
      const parsed = parseTableRow(line);
      if (!parsed) continue;

      const domain = extractDomain(parsed.url);
      const id = generateSlug(parsed.name);
      const authType = normalizeAuthType(parsed.auth);

      // Create entry
      const entry: ApiEntry = {
        id,
        name: parsed.name,
        url: parsed.url,
        category: currentCategory,
        description: parsed.description,
        domain,
        authType,
        https: parsed.https.toLowerCase() === 'yes',
        cors: (parsed.cors.toLowerCase() as 'yes' | 'no' | 'unknown') || 'unknown',
        source: 'public-apis',
        lastUpdated: new Date().toISOString(),
        protocols: ['REST'],
      };

      // Validate
      const error = validateEntry(entry);
      if (error) {
        errors.push(`Line ${i + 1}: ${error}`);
        continue;
      }

      // Check duplicates
      if (seenDomains.has(domain)) {
        warnings.push(`Duplicate domain: ${domain} (${entry.name})`);
      }
      seenDomains.add(domain);

      entries.push(entry);
    }
  }

  console.log(`✅ Parsed ${entries.length} APIs across ${new Set(entries.map(e => e.category)).size} categories\n`);

  if (warnings.length > 0) {
    console.log('⚠️  Warnings:');
    warnings.forEach(w => console.log(`  • ${w}`));
    console.log();
  }

  if (errors.length > 0) {
    console.log('❌ Errors:');
    errors.slice(0, 10).forEach(e => console.log(`  • ${e}`));
    if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);
    console.log();
  }

  // ─────────────────────────────────────────────────────────────────
  // BUILD INDEXES
  // ─────────────────────────────────────────────────────────────────

  console.log('🔍 Building indexes...');

  const indexes = {
    byDomain: {} as Record<string, ApiEntry[]>,
    byCategory: {} as Record<string, ApiEntry[]>,
    byAuthType: {} as Record<string, ApiEntry[]>,
    byName: {} as Record<string, ApiEntry>,
    byTag: {} as Record<string, ApiEntry[]>,
  };

  entries.forEach(entry => {
    // By Domain
    if (!indexes.byDomain[entry.domain]) indexes.byDomain[entry.domain] = [];
    indexes.byDomain[entry.domain].push(entry);

    // By Category
    if (!indexes.byCategory[entry.category]) indexes.byCategory[entry.category] = [];
    indexes.byCategory[entry.category].push(entry);

    // By Auth Type
    if (!indexes.byAuthType[entry.authType]) indexes.byAuthType[entry.authType] = [];
    indexes.byAuthType[entry.authType].push(entry);

    // By Name
    indexes.byName[entry.id] = entry;

    // By Tag
    const tags = generateTags(entry.name, entry.description, entry.category);
    tags.forEach(tag => {
      if (!indexes.byTag[tag]) indexes.byTag[tag] = [];
      indexes.byTag[tag].push(entry);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CALCULATE STATISTICS
  // ─────────────────────────────────────────────────────────────────

  const authTypeDistribution: Record<string, number> = {};
  entries.forEach(e => {
    authTypeDistribution[e.authType] = (authTypeDistribution[e.authType] || 0) + 1;
  });

  const statistics = {
    totalApis: entries.length,
    categoriesCount: Object.keys(indexes.byCategory).length,
    authTypeDistribution,
    validationStats: {
      validated: 0,
      working: 0,
      dead: 0,
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // BUILD REGISTRY
  // ─────────────────────────────────────────────────────────────────

  const registry: ApiRegistry = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    source: 'public-apis',
    entries,
    indexes,
    statistics,
  };

  // ─────────────────────────────────────────────────────────────────
  // PERSIST REGISTRY
  // ─────────────────────────────────────────────────────────────────

  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const registryFile = path.join(dataDir, 'api-registry.json');
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf-8');

  console.log(`✅ Registry written to ${registryFile}\n`);

  // ─────────────────────────────────────────────────────────────────
  // PRINT SUMMARY
  // ─────────────────────────────────────────────────────────────────

  console.log('📊 Registry Summary:');
  console.log(`   Total APIs: ${statistics.totalApis}`);
  console.log(`   Categories: ${statistics.categoriesCount}`);
  console.log(`   Auth Types: ${Object.entries(authTypeDistribution).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`   Unique Domains: ${Object.keys(indexes.byDomain).length}`);
  console.log(`   Tags: ${Object.keys(indexes.byTag).length}`);
  console.log('\n✨ Registry indexing complete!');
}

// ─────────────────────────────────────────────────────────────────
// CLI ENTRY POINT
// ─────────────────────────────────────────────────────────────────

indexApis().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
