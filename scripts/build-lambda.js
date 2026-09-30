const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const output = path.join(root, 'dist', 'lambda');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of ['lambda.js', 'server.js']) {
  fs.copyFileSync(path.join(root, name), path.join(output, name));
}
fs.cpSync(path.join(root, 'public'), path.join(output, 'public'), { recursive: true });
console.log(`Lambda source staged at ${output}`);
