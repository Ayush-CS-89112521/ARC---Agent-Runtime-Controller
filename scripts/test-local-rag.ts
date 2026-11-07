
import { KnowledgeBase } from '../src/rag/knowledge-base.js';

async function main() {
    console.log('🧪 Testing Local RAG (Xenova Embeddings + PGVector)...');

    const kb = new KnowledgeBase();

    try {
        console.log('Connecting to database...');
        await kb.connect();
        console.log('✅ Connected to database');

        const testContent = "The Architect Agent uses GitHub Copilot CLI for planning.";
        console.log('Generating embedding and adding document...');
        // This triggers the local Xenova embedding generation
        await kb.addWebScrapedDocs('test-url', 'test-topic', testContent);
        console.log('✅ Document added');

        console.log('Querying for context...');
        const results = await kb.queryContext("How does the Architect Agent work?", { limit: 1 });

        if (results.length > 0) {
            console.log('✅ Query successful!');
            console.log('Top match similarity:', results[0].similarity);
            console.log('Top match content:', results[0].content);
        } else {
            console.warn('⚠️ No results found (might be expected if DB was empty, but we just added one)');
        }

        await kb.disconnect();
        console.log('✅ Test Complete');

    } catch (error) {
        console.error('❌ RAG Test Failed:', error);
        if (String(error).includes('ECONNREFUSED')) {
            console.log('\n💡 HINT: Is PostgreSQL running?');
        }
        process.exit(1);
    }
}

main();
