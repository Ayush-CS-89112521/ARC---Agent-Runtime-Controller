# Local services

## PostgreSQL and models

Start Docker and follow the [PostgreSQL setup](POSTGRES_TEST_SETUP.md). Use the generated local connection. The RAG verifiers accept the isolated test database at `127.0.0.1:15432`.

Set `ARC_LOCAL_EMBEDDING_PATH` to a trusted directory containing `config.json`, `tokenizer.json`, `tokenizer_config.json`, and `onnx/model_quantized.onnx`. The bundle must provide a BERT model with hidden size 384 and a WordPiece tokenizer. The loader uses native CPU inference and verifies finite normalized vectors. Switching bundles changes the model fingerprint. Re-ingest documents for the new model to participate in retrieval.

The verified bundle was Sentence Transformers MiniLM-L6-v2 at revision `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`, using the published AVX2 quantized ONNX file under the local name `model_quantized.onnx`. Its SHA-256 is `b941bf19f1f1283680f449fa6a7336bb5600bdcd5f84d10ddc5cd72218a0fd21`. The verifier uses existing files. [Pinned model repository](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/tree/1110a243fdf4706b3f48f1d95db1a4f5529b4d41)

## Temporal

```sh
npm run temporal:start
npm run temporal:verify
npm run temporal:stop
```

The isolated server uses `127.0.0.1:17233`, namespace `arc-test`, and a local UI on port 18233. Setup writes an ignored `.env.temporal-test`. To launch a worker manually after setup, run `npm run build` and then `npm run temporal:worker`. The [environment example](../examples/temporal-test.env.example) shows the address, namespace, queue, and workspace path. Configure executable adapters separately.

The Compose server is for local development. The verification suite checks prepared Builder execution and restart behavior. See the [architecture guide](ARCHITECTURE.md) for write journal limits.

If you have local test containers from an earlier checkout, stop them before starting the ARC Compose services on the same ports. Keep their volumes if you need the old data. Update the namespace and workspace settings in any existing local Temporal environment file using the example above.
