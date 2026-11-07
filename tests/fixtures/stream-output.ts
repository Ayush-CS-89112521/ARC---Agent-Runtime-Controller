import { installSanitizedStreams } from '../../arc/src/sanitizer.js';
installSanitizedStreams();
const output = Buffer.from('fixture 😀 api_key=FIXTURE_NOT_A_REAL_KEY\n');
for (const byte of output) process.stdout.write(Buffer.of(byte));
process.stderr.write('password=OTHER_FIXTURE');
process.exit(0);
