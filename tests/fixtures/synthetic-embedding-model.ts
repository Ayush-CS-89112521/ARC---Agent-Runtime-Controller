import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import graphs from './synthetic-embedding-onnx.json';

export async function writeSyntheticModel(root: string, width: 384 | 8 = 384) {
  await mkdir(join(root, 'onnx'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'config.json'), JSON.stringify({ model_type: 'bert', hidden_size: 384, max_position_embeddings: 512 })),
    writeFile(join(root, 'tokenizer_config.json'), JSON.stringify({
      tokenizer_class: 'BertTokenizer', model_max_length: 512, pad_token: '[PAD]', unk_token: '[UNK]',
    })),
    writeFile(join(root, 'tokenizer.json'), JSON.stringify({
      version: '1.0',
      added_tokens: [],
      decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
      normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
      pre_tokenizer: { type: 'BertPreTokenizer' },
      post_processor: { type: 'BertProcessing', sep: ['[SEP]', 3], cls: ['[CLS]', 2] },
      model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##',
        max_input_chars_per_word: 100, vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, apple: 4, pear: 5 } },
    })),
    writeFile(join(root, 'onnx', 'model_quantized.onnx'), Buffer.from(width === 384 ? graphs.width384 : graphs.width8, 'base64')),
  ]);
}
