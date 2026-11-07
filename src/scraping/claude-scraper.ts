/**
 * Claude-powered Web Scraper
 * 
 * Uses Claude Haiku 4.5 for intelligent web scraping and data extraction.
 * Provides semantic understanding of HTML content.
 */

export interface ScrapedDocumentation {
    title: string;
    description: string;
    examples: string[];
    apiReference?: any;
    url: string;
    scrapedAt: Date;
}

export interface StackOverflowSolution {
    question: string;
    answer: string;
    votes: number;
    link: string;
    accepted: boolean;
}

export class ClaudeScraper {
    private anthropic: any;
    private cache: Map<string, any>;

    constructor() {
        this.cache = new Map();
    }

    private async getAnthropic() {
        if (!this.anthropic) {
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (!apiKey?.trim()) throw new Error('ANTHROPIC_API_KEY is required for documentation extraction');
            const Anthropic = (await import('@anthropic-ai/sdk')).default;
            this.anthropic = new Anthropic({ apiKey });
        }
        return this.anthropic;
    }

    /**
     * Scrape documentation from a URL
     */
    async scrapeDocumentation(
        url: string,
        topic: string
    ): Promise<ScrapedDocumentation> {
        // Check cache
        const cacheKey = `${url}:${topic}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            // Fetch HTML
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const html = await response.text();

            // Extract with Claude Haiku
            const anthropic = await this.getAnthropic();
            const message = await anthropic.messages.create({
                model: 'claude-haiku-4.5',
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: `Extract ${topic} documentation from this HTML page.

HTML Content (truncated):
${this.cleanHTML(html).slice(0, 50000)}

Please extract and return a JSON object with:
{
  "title": "Page title",
  "description": "Brief description of what this documentation covers",
  "examples": ["Array of code examples found"],
  "apiReference": {
    "functions": ["List of functions/methods"],
    "parameters": ["List of parameters"],
    "returnTypes": ["List of return types"]
  }
}

Focus on ${topic} specifically. Return ONLY valid JSON, no markdown formatting.`
                }]
            });

            const content = message.content[0].text;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const data = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);

            const result: ScrapedDocumentation = {
                ...data,
                url,
                scrapedAt: new Date()
            };

            // Cache the result
            this.cache.set(cacheKey, result);

            return result;
        } catch (error) {
            console.error(`Failed to scrape ${url}:`, error);

            // Return minimal fallback
            return {
                title: topic,
                description: `Failed to scrape documentation for ${topic}`,
                examples: [],
                url,
                scrapedAt: new Date()
            };
        }
    }

    /**
     * Search Stack Overflow for error solutions
     */
    async searchStackOverflow(
        errorMessage: string
    ): Promise<StackOverflowSolution[]> {
        // Check cache
        const cacheKey = `so:${errorMessage}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            // Search Stack Overflow
            const searchQuery = encodeURIComponent(errorMessage.slice(0, 200));
            const searchUrl = `https://stackoverflow.com/search?q=${searchQuery}`;

            const response = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ARC-Bot/1.0)'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();

            // Extract with Claude Haiku
            const anthropic = await this.getAnthropic();
            const message = await anthropic.messages.create({
                model: 'claude-haiku-4.5',
                max_tokens: 2048,
                messages: [{
                    role: 'user',
                    content: `Extract the top 3 most relevant solutions for this error from Stack Overflow search results.

Error: ${errorMessage}

HTML Content (truncated):
${this.cleanHTML(html).slice(0, 30000)}

Return a JSON array of solutions:
[
  {
    "question": "Question title",
    "answer": "Summary of the accepted or highest-voted answer",
    "votes": number,
    "link": "Full URL to the question",
    "accepted": true/false
  }
]

Return ONLY valid JSON array, no markdown formatting.`
                }]
            });

            const content = message.content[0].text;
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            const solutions = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);

            // Cache the result
            this.cache.set(cacheKey, solutions);

            return solutions;
        } catch (error) {
            console.error('Failed to search Stack Overflow:', error);
            return [];
        }
    }

    /**
     * Get package information from npm
     */
    async getPackageInfo(packageName: string): Promise<any> {
        // Check cache
        const cacheKey = `npm:${packageName}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            const url = `https://www.npmjs.com/package/${packageName}`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();

            // Extract with Claude Haiku
            const anthropic = await this.getAnthropic();
            const message = await anthropic.messages.create({
                model: 'claude-haiku-4.5',
                max_tokens: 2048,
                messages: [{
                    role: 'user',
                    content: `Extract package information from this npm page.

HTML Content (truncated):
${this.cleanHTML(html).slice(0, 30000)}

Return JSON:
{
  "name": "package name",
  "version": "latest version",
  "description": "package description",
  "weeklyDownloads": "number of weekly downloads",
  "repository": "repository URL",
  "dependencies": ["list of main dependencies"],
  "keywords": ["list of keywords"]
}

Return ONLY valid JSON, no markdown formatting.`
                }]
            });

            const content = message.content[0].text;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const packageInfo = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);

            // Cache the result
            this.cache.set(cacheKey, packageInfo);

            return packageInfo;
        } catch (error) {
            console.error(`Failed to get package info for ${packageName}:`, error);
            return null;
        }
    }

    /**
     * Scrape GitHub repository README
     */
    async scrapeGitHubReadme(repoUrl: string): Promise<string> {
        // Check cache
        const cacheKey = `gh:${repoUrl}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            // Convert to raw README URL
            const readmeUrl = repoUrl
                .replace('github.com', 'raw.githubusercontent.com')
                .replace(/\/$/, '') + '/main/README.md';

            const response = await fetch(readmeUrl);
            if (!response.ok) {
                // Try master branch
                const masterUrl = readmeUrl.replace('/main/', '/master/');
                const masterResponse = await fetch(masterUrl);
                if (!masterResponse.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const readme = await masterResponse.text();
                this.cache.set(cacheKey, readme);
                return readme;
            }

            const readme = await response.text();
            this.cache.set(cacheKey, readme);
            return readme;
        } catch (error) {
            console.error(`Failed to scrape GitHub README for ${repoUrl}:`, error);
            return '';
        }
    }

    /**
     * Get API documentation by ID (using API registry)
     */
    async getApiDocs(apiId: string): Promise<ScrapedDocumentation | null> {
        // Check cache with api: prefix
        const cacheKey = `api:${apiId}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            // Dynamically import to avoid circular dependencies if any
            const { ApiDiscoveryService } = await import('../execution/api-discovery-service.js');
            const service = new ApiDiscoveryService();
            const api = await service.findApi(apiId);

            if (!api) {
                console.warn(`API not found: ${apiId}`);
                return null;
            }

            console.log(`\n📚 Scraping documentation for ${api.name}...`);
            const docs = await this.scrapeDocumentation(api.url, `${api.name} API`);

            // Cache the result
            this.cache.set(cacheKey, docs);
            return docs;
        } catch (error) {
            console.error(`Failed to get API docs for ${apiId}:`, error);
            return null;
        }
    }

    /**
     * Clean HTML by removing scripts, styles, and unnecessary whitespace
     */
    private cleanHTML(html: string): string {
        return html
            // Remove script tags
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            // Remove style tags
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            // Remove comments
            .replace(/<!--[\s\S]*?-->/g, '')
            // Remove excessive whitespace
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Clear the cache
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Get cache statistics
     */
    getCacheStats(): { size: number; keys: string[] } {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }
}
