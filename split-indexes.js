// One-time/backfill utility for outputs generated before split API indexes
// were added. It does not download or modify source GTFS data.

const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, 'output');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const providerDir = path.join(outputDir, entry.name);
  const combinedPath = path.join(providerDir, '_indexes.json');
  if (!fs.existsSync(combinedPath)) continue;

  console.log(`Splitting ${entry.name}...`);
  const indexes = JSON.parse(fs.readFileSync(combinedPath, 'utf8'));
  const splitDir = path.join(providerDir, '_api_indexes');

  for (const [name, value] of Object.entries(indexes)) {
    if (name === 'generated_at' || name === 'content_sha256') continue;
    writeJson(path.join(splitDir, `${name}.json`), value);
  }

  writeJson(path.join(splitDir, '_meta.json'), {
    generated_at: indexes.generated_at || null,
    content_sha256: indexes.content_sha256 || null,
    sections: Object.keys(indexes).filter(name =>
      name !== 'generated_at' && name !== 'content_sha256'
    ),
  });
}

console.log('Split index backfill complete.');
