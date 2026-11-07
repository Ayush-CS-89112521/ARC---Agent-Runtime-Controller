import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ClaudeScraper } from '../../src/scraping/claude-scraper';

// Mock Anthropic SDK
const mockAnthropicCreate = mock((_args?: any) => {
    return Promise.resolve({
        content: [{
            text: JSON.stringify({
                title: 'Mock Title',
                description: 'Mock Description',
                examples: ['example 1'],
                apiReference: { functions: ['func1'] }
            })
        }]
    });
});

mock.module('@anthropic-ai/sdk', () => {
    return {
        default: class {
            messages = {
                create: mockAnthropicCreate
            };
        }
    };
});

// Mock fetch
const originalFetch = global.fetch;
const mockFetchResponse = mock((url: string) => {
    return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body><h1>Mock Content</h1></body></html>')
    });
});

describe('ClaudeScraper', () => {
    let scraper: ClaudeScraper;
    let originalApiKey: string | undefined;
    let originalGithubToken: string | undefined;

    beforeEach(() => {
        originalApiKey = process.env.ANTHROPIC_API_KEY;
        originalGithubToken = process.env.GITHUB_TOKEN;
        process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key';
        scraper = new ClaudeScraper();
        global.fetch = mockFetchResponse as any;

        mockAnthropicCreate.mockReset();
        mockAnthropicCreate.mockResolvedValue({
            content: [{
                text: JSON.stringify({
                    title: 'Mock Title',
                    description: 'Mock Description',
                    examples: ['example 1'],
                    apiReference: { functions: ['func1'] }
                })
            }]
        } as any);

        mockFetchResponse.mockReset();
        mockFetchResponse.mockResolvedValue({
            ok: true,
            status: 200,
            text: () => Promise.resolve('<html><body><h1>Mock Content</h1></body></html>')
        } as any);
    });

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = originalApiKey;
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    });

    describe('scrapeDocumentation', () => {
        it('does not use a GitHub credential for Anthropic requests', async () => {
            delete process.env.ANTHROPIC_API_KEY;
            process.env.GITHUB_TOKEN = 'fixture-github-credential';
            const result = await scraper.scrapeDocumentation('https://example.com/docs', 'testing');
            expect(result.description).toContain('Failed to scrape documentation');
            expect(mockAnthropicCreate).not.toHaveBeenCalled();
        });

        it('should scrape documentation and cache results', async () => {
            const url = 'https://example.com/docs';
            const topic = 'testing';

            const result = await scraper.scrapeDocumentation(url, topic);

            expect(result.title).toBe('Mock Title');
            expect(result.url).toBe(url);
            expect(mockFetchResponse).toHaveBeenCalled();
            expect(mockAnthropicCreate).toHaveBeenCalled();

            // Verify caching
            const result2 = await scraper.scrapeDocumentation(url, topic);
            expect(result2).toEqual(result);
            expect(mockFetchResponse).toHaveBeenCalledTimes(1);
        });

        it('should return fallback object on fetch errors', async () => {
            mockFetchResponse.mockImplementationOnce(() =>
                Promise.resolve({
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    text: () => Promise.resolve('')
                } as any)
            );

            const result = await scraper.scrapeDocumentation('https://badurl.com', 'topic');
            expect(result.title).toBe('topic');
            expect(result.description).toContain('Failed to scrape');
        });

        it('should handle malformed JSON from Claude', async () => {
            mockAnthropicCreate.mockResolvedValueOnce({
                content: [{ text: 'This is not JSON but it contains { "title": "Inside" } somewhere' }]
            } as any);

            const result = await scraper.scrapeDocumentation('https://example.com', 'topic');
            expect(result.title).toBe('Inside');
        });
    });

    describe('searchStackOverflow', () => {
        it('should extract solutions from Stack Overflow', async () => {
            mockAnthropicCreate.mockResolvedValueOnce({
                content: [{
                    text: JSON.stringify([{
                        question: 'How to test?',
                        answer: 'Use Bun',
                        votes: 10,
                        link: 'https://so.com/1',
                        accepted: true
                    }])
                }]
            } as any);

            const solutions = await scraper.searchStackOverflow('testing');
            expect(solutions).toHaveLength(1);
            expect(solutions[0].answer).toBe('Use Bun');
        });
    });

    describe('getPackageInfo', () => {
        it('should extract package info from npm/github', async () => {
            mockAnthropicCreate.mockResolvedValueOnce({
                content: [{
                    text: JSON.stringify({
                        name: 'test-pkg',
                        version: '1.0.0',
                        dependencies: {}
                    })
                }]
            } as any);

            const info = await scraper.getPackageInfo('test-pkg');
            expect(info.name).toBe('test-pkg');
        });
    });

    describe('scrapeGitHubReadme', () => {
        it('should scrape README from main branch', async () => {
            mockFetchResponse.mockImplementationOnce((url: string) => {
                if (url.includes('/main/')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('# Main README') } as any);
                return Promise.resolve({ ok: false, status: 404 } as any);
            });

            const readme = await scraper.scrapeGitHubReadme('https://github.com/user/repo');
            expect(readme).toBe('# Main README');
        });

        it('should fallback to master branch if main fails', async () => {
            mockFetchResponse.mockImplementation((url: string) => {
                if (url.includes('/main/')) return Promise.resolve({ ok: false, status: 404 } as any);
                if (url.includes('/master/')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('# Master README') } as any);
                return Promise.resolve({ ok: false, status: 404 } as any);
            });

            const readme = await scraper.scrapeGitHubReadme('https://github.com/user/repo');
            expect(readme).toBe('# Master README');
        });
    });

    describe('Utility Methods', () => {
        it('should clear cache and get stats', async () => {
            scraper.clearCache();
            const stats = scraper.getCacheStats();
            expect(stats.size).toBe(0);

            mockAnthropicCreate.mockResolvedValueOnce({
                content: [{ text: JSON.stringify({ title: 'T' }) }]
            } as any);
            await scraper.scrapeDocumentation('h1', 't1');

            expect(scraper.getCacheStats().size).toBe(1);
            scraper.clearCache();
            expect(scraper.getCacheStats().size).toBe(0);
        });

        it('should clean HTML correctly', async () => {
            // cleanHTML is private but we can test it indirectly via scrapeDocumentation
            mockAnthropicCreate.mockImplementationOnce(({ messages }: any) => {
                const content = messages[0].content;
                return Promise.resolve({
                    content: [{ text: JSON.stringify({ title: content.includes('<script>') ? 'fail' : 'pass' }) }]
                });
            });

            const html = '<html><script>alert(1)</script><style>.b{}</style><body><!-- comment -->  text  </body></html>';
            mockFetchResponse.mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: () => Promise.resolve(html)
            } as any);

            const result = await scraper.scrapeDocumentation('h', 't');
            expect(result.title).toBe('pass');
        });
    });
});
