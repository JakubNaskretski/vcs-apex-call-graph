#!/usr/bin/env node
'use strict';

// Fast, counts-safe repository preflight. This intentionally does not print
// matched text. The release skill's leak scanner and human scrub remain the
// final authority over the exact VSIX payload.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEXT_EXTENSIONS = new Set([
  '.apex', '.app', '.cjs', '.cls', '.cmp', '.component', '.css', '.html', '.js',
  '.json', '.md', '.mjs', '.page', '.trigger', '.txt', '.vsixmanifest', '.xml', '.yaml', '.yml',
]);
const EXACT_TEXT_FILES = new Set(['.gitignore', '.npmignore', '.vscodeignore', 'LICENSE']);
const FORBIDDEN_BASENAMES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'CONTRACT.md', 'MEMORY.md',
  'Codex-config-setup.md', 'settings.json', 'settings.local.json',
]);

const findings = [];
function finding(rule, relPath) {
  findings.push({ rule, path: relPath.replace(/\\/g, '/') });
}

function gitFiles() {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('git ls-files failed during privacy preflight');
  return result.stdout.split('\0').filter(Boolean);
}

function isTextFile(relPath) {
  const base = path.basename(relPath);
  return EXACT_TEXT_FILES.has(base) || TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function loadDenylist() {
  const denylistPath = path.join(os.homedir(), '.Codex', 'anonymize-denylist.txt');
  let text;
  try {
    text = fs.readFileSync(denylistPath, 'utf8');
  } catch (_) {
    return [];
  }
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('path:'));
}

const contentRules = [
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['cloud-access-key', /AKIA[0-9A-Z]{16}/],
  ['source-token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['chat-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['bearer-token', /\bbearer\s+[A-Za-z0-9._~-]{20,}/i],
  ['credential-assignment', /\b(?:api[_-]?key|password|passwd|secret|token)\b\s*[:=]\s*['\"][^'\"\r\n]{8,}['\"]/i],
  ['machine-home-path', /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\)/i],
];

// Info-ZIP treats entry arguments as wildcard patterns even when they are
// passed directly to the process (there is no reliable `--` literal-name
// mode). Escape its pattern metacharacters so entries such as
// `[Content_Types].xml` are read and scanned instead of silently skipped.
function escapeUnzipPattern(entry) {
  return entry.replace(/([\\*?[\]])/g, '\\$1');
}

const files = gitFiles();
const denyTerms = loadDenylist();

function scanText(relPath, text) {
  for (const [rule, pattern] of contentRules) {
    if (pattern.test(text)) finding(rule, relPath);
  }
  const lower = text.toLowerCase();
  denyTerms.forEach((term, index) => {
    if (lower.includes(term.toLowerCase())) finding(`denylist-term-${index + 1}`, relPath);
  });
}

for (const relPath of files) {
  const base = path.basename(relPath);
  if (FORBIDDEN_BASENAMES.has(base) || /\.local\.md$/i.test(base)) finding('internal-file', relPath);
  if (relPath === 'samples' || relPath.startsWith('samples/')) finding('samples-tracked', relPath);
  if (!isTextFile(relPath)) continue;
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  } catch (_) {
    continue;
  }
  scanText(relPath, text);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (packageJson.publisher !== 'Skrety') finding('publisher-identity', 'package.json');
for (const field of ['author', 'repository', 'homepage', 'bugs']) {
  if (Object.prototype.hasOwnProperty.call(packageJson, field)) finding(`public-metadata-${field}`, 'package.json');
}

const vscodeIgnore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
for (const required of ['dev/**', 'test-fixtures/**', '*.local.md', 'CLAUDE.md', 'MEMORY.md', 'CONTRACT.md']) {
  if (!vscodeIgnore.split(/\r?\n/).includes(required)) finding('package-exclusion', `.vscodeignore:${required}`);
}

const npmIgnorePath = path.join(ROOT, '.npmignore');
if (!fs.existsSync(npmIgnorePath)) {
  finding('npm-exclusion', '.npmignore');
} else {
  const npmIgnore = fs.readFileSync(npmIgnorePath, 'utf8').split(/\r?\n/);
  for (const required of ['dev/**', 'test-fixtures/**', 'samples/**', '*.local.md']) {
    if (!npmIgnore.includes(required)) finding('npm-exclusion', `.npmignore:${required}`);
  }
}

if (process.argv.includes('--vsix')) {
  const vsixName = `${packageJson.name}-${packageJson.version}.vsix`;
  const vsixPath = path.join(ROOT, vsixName);
  if (!fs.existsSync(vsixPath)) {
    finding('vsix-missing', vsixName);
  } else {
    const listing = spawnSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' });
    if (listing.status !== 0) {
      finding('vsix-invalid', vsixName);
    } else {
      const archiveEntries = listing.stdout.split(/\r?\n/).filter(Boolean);
      for (const entry of archiveEntries) {
        const normalized = entry.replace(/\\/g, '/');
        if (/(^|\/)(dev|test-fixtures|samples)(\/|$)/i.test(normalized)
          || /(^|\/)(AGENTS\.md|CLAUDE\.md|CONTRACT\.md|MEMORY\.md|[^/]*\.local\.md)$/i.test(normalized)) {
          finding('vsix-internal-file', normalized);
        }
        const extracted = spawnSync('unzip', ['-p', vsixPath, escapeUnzipPattern(entry)], {
          maxBuffer: 16 * 1024 * 1024,
        });
        if (extracted.status !== 0) finding('vsix-read-error', normalized);
        else {
          // Scan every entry, including binary assets. latin1 preserves each
          // byte one-to-one so ASCII secrets, contacts, machine paths, and
          // metadata embedded in a binary remain detectable without trying
          // to interpret arbitrary bytes as UTF-8.
          const encoding = isTextFile(normalized) ? 'utf8' : 'latin1';
          scanText(`vsix:${normalized}`, extracted.stdout.toString(encoding));
        }
      }
    }
  }
}

findings.sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
if (findings.length) {
  console.error(`privacy-check: FAIL (${findings.length} finding${findings.length === 1 ? '' : 's'})`);
  for (const item of findings) console.error(`  ${item.rule}: ${item.path}`);
  process.exit(1);
}

const scope = process.argv.includes('--vsix') ? `${files.length} repository files + current VSIX` : `${files.length} repository files`;
console.log(`privacy-check: PASS (${scope} checked; matched values never printed)`);
