#!/usr/bin/env node

// Malaysia GTFS Static Preprocessor
// Downloads all 15 active data.gov.my GTFS static feeds and parses them into JSON
// Always force-refreshes: no skip/hash logic
//
// Usage:
//   node index.js                    Process all providers
//   node index.js --provider ktmb    Process one provider only
//   node index.js --verbose          Show detailed output

const fs = require('fs');
const path = require('path');
const { PROVIDERS } = require('./providers');
const { processProvider, exportAggregate, exportProvidersJson } = require('./processor');

const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_TMP = path.join(__dirname, '.output_tmp');

function cleanDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function swapOutput(tmpDir, finalDir) {
  const oldDir = path.join(__dirname, '.output_old');
  // Rename current output out of the way (if it exists)
  if (fs.existsSync(finalDir)) {
    fs.renameSync(finalDir, oldDir);
  }
  // Promote temp output to final
  fs.renameSync(tmpDir, finalDir);
  // Remove old output
  if (fs.existsSync(oldDir)) {
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    providerFilter: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      opts.providerFilter = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      opts.verbose = true;
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  console.log('='.repeat(60));
  console.log('  Malaysia GTFS Static Preprocessor');
  console.log('  15 active feeds from data.gov.my (force refresh)');
  console.log('='.repeat(60));
  console.log(`  Data directory:   ${DATA_DIR}`);
  console.log(`  Output directory: ${OUTPUT_DIR}`);
  console.log(`  Started at:       ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // Clean data directory and temp output to prevent accumulation
  // NOTE: We do NOT delete OUTPUT_DIR here — the API backend reads from it.
  // Instead we generate into .output_tmp and swap atomically at the end.
  console.log('\nCleaning previous data and temp output...');
  cleanDir(DATA_DIR);
  cleanDir(OUTPUT_TMP);
  console.log('  Clean. Starting fresh.');

  // Filter providers if requested
  let providers = PROVIDERS;
  if (opts.providerFilter) {
    providers = PROVIDERS.filter(p => p.key === opts.providerFilter);
    if (providers.length === 0) {
      console.error(`\nUnknown provider: ${opts.providerFilter}`);
      console.error(`Available providers: ${PROVIDERS.map(p => p.key).join(', ')}`);
      process.exit(1);
    }
    console.log(`\nProcessing single provider: ${providers[0].key}`);
  }

  // Process each provider (always force refresh)
  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${i + 1}/${providers.length}] ${provider.key}`);
    console.log(`${'─'.repeat(60)}`);

    try {
      const result = await processProvider(provider, DATA_DIR, OUTPUT_TMP);
      results.push(result);

      if (result.status === 'success') {
        successCount++;
      } else {
        failCount++;
        if (opts.verbose && result.error) {
          console.log(`  Detail: ${result.error}`);
        }
      }
    } catch (err) {
      console.error(`  UNEXPECTED ERROR: ${err.message}`);
      if (opts.verbose) {
        console.error(err.stack);
      }
      results.push({
        key: provider.key,
        status: 'error',
        error: err.message,
      });
      failCount++;
    }
  }

  // Generate aggregate outputs
  console.log(`\n${'─'.repeat(60)}`);
  console.log('Generating aggregate outputs...');
  console.log(`${'─'.repeat(60)}`);

  const summary = exportAggregate(results, OUTPUT_TMP);

  // Export provider registry for Laravel
  const providersList = exportProvidersJson(PROVIDERS, OUTPUT_TMP);
  console.log(`  Exported _providers.json (${providersList.length} providers)`);

  // Atomic swap: promote temp output to live output (API sees no gap)
  console.log('\nSwapping output directories...');
  swapOutput(OUTPUT_TMP, OUTPUT_DIR);
  console.log('  Done.');

  // Final report
  const elapsed = process.uptime();
  console.log(`\n${'='.repeat(60)}`);
  console.log('  COMPLETE');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Total providers: ${providers.length}`);
  console.log(`  Successful:      ${successCount}`);
  console.log(`  Failed:          ${failCount}`);
  console.log(`  Time elapsed:    ${elapsed.toFixed(1)}s`);
  console.log(`  Output:          ${OUTPUT_DIR}`);
  console.log(`${'='.repeat(60)}`);

  // Print per-provider status table
  console.log('\nProvider Status:');
  console.log('─'.repeat(65));
  console.log(
    'Provider'.padEnd(25) +
    'Status'.padEnd(20) +
    'Routes'.padStart(8) +
    'Stops'.padStart(8) +
    'Trips'.padStart(8)
  );
  console.log('─'.repeat(65));

  for (const result of results) {
    const stats = result.stats || {};
    console.log(
      result.key.padEnd(25) +
      result.status.padEnd(20) +
      String(stats.route_count || '-').padStart(8) +
      String(stats.stop_count || '-').padStart(8) +
      String(stats.trip_count || '-').padStart(8)
    );
  }
  console.log('─'.repeat(65));

  // Exit with appropriate code
  if (failCount > 0 && successCount === 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
