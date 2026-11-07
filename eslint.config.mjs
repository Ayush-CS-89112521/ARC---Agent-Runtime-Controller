import ts from 'typescript-eslint';

export default [{ ignores: ['**/node_modules/**', '**/dist/**', '.audit/**'] }, {
  files: ['src/**/*.ts'], languageOptions: { parser: ts.parser },
  rules: { 'no-debugger': 'error', 'no-unreachable': 'error', 'no-duplicate-case': 'error',
    'no-unsafe-finally': 'error', 'no-constant-condition': ['error', { checkLoops: false }] },
}];
