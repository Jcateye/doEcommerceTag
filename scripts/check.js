const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const requiredFiles = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'styles.css',
  'README.md',
  'lib/xlsx.full.min.js',
]

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)))
if (missing.length) {
  console.error('Missing files:\n' + missing.join('\n'))
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
if (manifest.manifest_version !== 3) {
  console.error('manifest_version must be 3')
  process.exit(1)
}

console.log('check ok')
