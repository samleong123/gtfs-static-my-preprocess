// GTFS Static Processor
// Downloads, extracts, parses, validates, and exports GTFS static feeds

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const { parse: csvParse } = require('csv-parse/sync');

// ─── Rate Limiter ────────────────────────────────────────────────────────────
// Respects data.gov.my quota: 4 GTFS Static requests per minute
// We use 16-second intervals (safe margin)

class RateLimiter {
  constructor(minIntervalMs = 16000) {
    this.minIntervalMs = minIntervalMs;
    this.lastRequestTime = 0;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      const delay = this.minIntervalMs - elapsed;
      await new Promise(r => setTimeout(r, delay));
    }
    this.lastRequestTime = Date.now();
  }
}

const rateLimiter = new RateLimiter();

// ─── Allowed GTFS Files ──────────────────────────────────────────────────────
// Only extract recognized GTFS files. Reject path traversal and unknown files.

const ALLOWED_GTFS_FILES = new Set([
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'shapes.txt',
  'frequencies.txt',
  'feed_info.txt',
  'transfers.txt',
  'fare_attributes.txt',
  'fare_rules.txt',
  // GTFS Fares v2 (used by Melaka/Johor)
  'areas.txt',
  'stop_areas.txt',
  'fare_media.txt',
  'rider_categories.txt',
  'fare_products.txt',
  'fare_leg_rules.txt',
  'fare_leg_join_rules.txt',
  'fare_transfer_rules.txt',
  'fare_timeframes.txt',
]);

// Core files that must be present for a usable feed
const CORE_GTFS_FILES = [
  'agency.txt',
  'routes.txt',
  'stops.txt',
  'trips.txt',
  'stop_times.txt',
];

// ─── Directory Helpers ────────────────────────────────────────────────────────

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sha256(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Download ─────────────────────────────────────────────────────────────────

async function downloadFeed(provider, dataDir) {
  const zipDir = path.join(dataDir, 'zips');
  ensureDir(zipDir);

  const headers = {
    'User-Agent': 'GTFS-Static-Preprocessor/1.0 (Malaysia Transit Project)',
    'Accept': 'application/zip, application/octet-stream, */*',
  };

  console.log(`  Downloading ${provider.gtfs_url}`);

  await rateLimiter.wait();

  let response;
  try {
    response = await fetch(provider.gtfs_url, {
      headers,
      redirect: 'follow',
      timeout: 60000,
      size: 100 * 1024 * 1024, // 100MB max download
    });
  } catch (err) {
    return { success: false, error: `Network error: ${err.message}` };
  }

  if (!response.ok) {
    const bodyPreview = await response.text().catch(() => '');
    return {
      success: false,
      error: `HTTP ${response.status}: ${bodyPreview.slice(0, 200)}`,
    };
  }

  const buffer = await response.buffer();
  const hash = sha256(buffer);

  // Save ZIP with content hash for deduplication
  const zipPath = path.join(zipDir, `${provider.key}_${hash.replace('sha256:', '')}.zip`);
  fs.writeFileSync(zipPath, buffer);

  return {
    success: true,
    zipPath,
    hash,
    size: buffer.length,
    httpStatus: response.status,
  };
}

// ─── ZIP Extraction ───────────────────────────────────────────────────────────

function extractZip(zipBuffer) {
  // Verify ZIP signature (PK\x03\x04)
  if (zipBuffer.length < 4 ||
      zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4B ||
      zipBuffer[2] !== 0x03 || zipBuffer[3] !== 0x04) {
    return { success: false, error: 'Invalid ZIP signature' };
  }

  // Safety: reject excessively small buffers
  if (zipBuffer.length < 22) {
    return { success: false, error: 'ZIP file too small' };
  }

  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    return { success: false, error: `Failed to open ZIP: ${err.message}` };
  }

  const entries = zip.getEntries();
  const extracted = {};

  for (const entry of entries) {
    // Skip directories
    if (entry.isDirectory) continue;

    // Get just the filename (handle nested paths like __MACOSX/._agency.txt)
    const baseName = path.basename(entry.entryName).toLowerCase();

    // Skip macOS AppleDouble files
    if (baseName.startsWith('._') || baseName === '__macosx') continue;

    // Only allow known GTFS files
    if (!ALLOWED_GTFS_FILES.has(baseName)) {
      continue;
    }

    // Safety: reject decompression bombs (ratio > 100x)
    if (entry.header.size > 0 && entry.header.compressedSize > 0) {
      const ratio = entry.header.size / entry.header.compressedSize;
      if (ratio > 100) {
        return {
          success: false,
          error: `Suspicious compression ratio (${ratio.toFixed(1)}x) in ${baseName}`,
        };
      }
    }

    // Safety: max extracted file size 500MB
    if (entry.header.size > 500 * 1024 * 1024) {
      return {
        success: false,
        error: `Extracted file ${baseName} exceeds 500MB limit`,
      };
    }

    try {
      const content = entry.getData();
      if (content && content.length > 0) {
        extracted[baseName] = content.toString('utf-8');
      }
    } catch (err) {
      return {
        success: false,
        error: `Failed to extract ${baseName}: ${err.message}`,
      };
    }
  }

  return { success: true, files: extracted };
}

// ─── CSV Parsing ──────────────────────────────────────────────────────────────
// Standards-compliant: handles quoting, commas in values, UTF-8 BOM, blanks.
// Headers are preserved as-is (case-sensitive GTFS names).

function parseCsv(rawText) {
  // Remove UTF-8 BOM if present
  let text = rawText;
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  // Handle \r\n line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length === 0) return [];

  // Parse header
  const headerLine = lines[0];
  const headers = parseCsvLine(headerLine);

  // Parse rows
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const val = j < values.length ? values[j] : '';
      // Store null for empty optional fields, preserve 0 and other falsy values
      row[headers[j]] = val === '' ? null : val;
    }
    rows.push(row);
  }

  return rows;
}

// Parse a single CSV line, handling quoted fields with commas and escaped quotes
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ("")
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        result.push(current);
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  result.push(current);
  return result;
}

// ─── Lookup Maps ──────────────────────────────────────────────────────────────
// Build fast key→value maps for referential integrity checks

function buildLookupMap(rows, keyField) {
  const map = {};
  for (const row of rows) {
    const key = row[keyField];
    if (key != null) {
      map[key] = row;
    }
  }
  return map;
}

function buildLookupSet(rows, keyField) {
  const set = new Set();
  for (const row of rows) {
    const key = row[keyField];
    if (key != null) {
      set.add(key);
    }
  }
  return set;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateGtfsData(data) {
  const errors = [];
  const warnings = [];
  const stats = {};

  // ── Critical files check ──
  for (const file of CORE_GTFS_FILES) {
    if (!data[file] || data[file].length === 0) {
      errors.push(`Missing or empty critical file: ${file}`);
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings: ['Feed has missing core files; cannot validate relationships'],
      stats: { status: 'invalid' },
    };
  }

  // ── Build indexes ──
  const routeIds = buildLookupSet(data['routes.txt'], 'route_id');
  const stopIds = buildLookupSet(data['stops.txt'], 'stop_id');
  const tripMap = buildLookupMap(data['trips.txt'], 'trip_id');
  const tripIds = new Set(Object.keys(tripMap));

  // ── Stats ──
  stats.agency_count = (data['agency.txt'] || []).length;
  stats.route_count = data['routes.txt'].length;
  stats.stop_count = data['stops.txt'].length;
  stats.trip_count = data['trips.txt'].length;
  stats.stop_time_count = data['stop_times.txt'].length;
  stats.shape_count = (data['shapes.txt'] || []).length;
  stats.frequency_count = (data['frequencies.txt'] || []).length;
  stats.calendar_count = (data['calendar.txt'] || []).length;
  stats.calendar_date_count = (data['calendar_dates.txt'] || []).length;

  // Check for optional files
  stats.has_shapes = !!data['shapes.txt'] && data['shapes.txt'].length > 0;
  stats.has_frequencies = !!data['frequencies.txt'] && data['frequencies.txt'].length > 0;
  stats.has_calendar = !!data['calendar.txt'] && data['calendar.txt'].length > 0;
  stats.has_calendar_dates = !!data['calendar_dates.txt'] && data['calendar_dates.txt'].length > 0;
  stats.has_feed_info = !!data['feed_info.txt'] && data['feed_info.txt'].length > 0;

  // Fares v2 files
  const faresV2Files = [
    'areas.txt', 'stop_areas.txt', 'fare_media.txt', 'rider_categories.txt',
    'fare_products.txt', 'fare_leg_rules.txt',
  ];
  stats.has_fares_v2 = faresV2Files.some(f => data[f] && data[f].length > 0);

  // ── Referential integrity: trips → routes ──
  let missingRouteCount = 0;
  for (const trip of data['trips.txt']) {
    if (trip.route_id && !routeIds.has(trip.route_id)) {
      missingRouteCount++;
    }
  }
  if (missingRouteCount > 0) {
    const pct = ((missingRouteCount / data['trips.txt'].length) * 100).toFixed(1);
    if (missingRouteCount === data['trips.txt'].length) {
      errors.push(`All ${missingRouteCount} trips reference non-existent route_ids`);
    } else if (parseFloat(pct) > 10) {
      errors.push(`${pct}% of trips (${missingRouteCount}) reference non-existent route_ids`);
    } else {
      warnings.push(`${pct}% of trips (${missingRouteCount}) reference non-existent route_ids`);
    }
  }

  // ── Referential integrity: stop_times → trips ──
  let missingTripCount = 0;
  for (const st of data['stop_times.txt']) {
    if (st.trip_id && !tripIds.has(st.trip_id)) {
      missingTripCount++;
    }
  }
  if (missingTripCount > 0) {
    const pct = ((missingTripCount / data['stop_times.txt'].length) * 100).toFixed(1);
    if (parseFloat(pct) > 5) {
      errors.push(`${pct}% of stop_times (${missingTripCount}) reference non-existent trip_ids`);
    } else {
      warnings.push(`${pct}% of stop_times (${missingTripCount}) reference non-existent trip_ids`);
    }
  }

  // ── Referential integrity: stop_times → stops ──
  let missingStopCount = 0;
  for (const st of data['stop_times.txt']) {
    if (st.stop_id && !stopIds.has(st.stop_id)) {
      missingStopCount++;
    }
  }
  if (missingStopCount > 0) {
    const pct = ((missingStopCount / data['stop_times.txt'].length) * 100).toFixed(1);
    if (parseFloat(pct) > 5) {
      errors.push(`${pct}% of stop_times (${missingStopCount}) reference non-existent stop_ids`);
    } else {
      warnings.push(`${pct}% of stop_times (${missingStopCount}) reference non-existent stop_ids`);
    }
  }

  // ── Calendar expiry check ──
  if (data['calendar.txt'] && data['calendar.txt'].length > 0) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let hasActiveService = false;
    let latestEndDate = '';

    for (const cal of data['calendar.txt']) {
      if (cal.end_date && cal.end_date >= today) {
        hasActiveService = true;
      }
      if (cal.end_date && cal.end_date > latestEndDate) {
        latestEndDate = cal.end_date;
      }
    }

    stats.service_end_date = latestEndDate;

    if (!hasActiveService) {
      warnings.push('All calendar services have expired (no active service after today)');
      stats.calendar_expired = true;
    } else {
      stats.calendar_expired = false;
    }
  }

  // ── Empty critical file checks ──
  if (data['stops.txt'].length === 0) {
    errors.push('stops.txt is empty');
  }
  if (data['routes.txt'].length === 0) {
    errors.push('routes.txt is empty');
  }

  // ── Determine status ──
  const hasBlockingErrors = errors.length > 0;
  stats.status = hasBlockingErrors ? 'failed' : 'healthy';

  return {
    valid: !hasBlockingErrors,
    errors,
    warnings,
    stats,
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

function exportProviderJson(provider, data, validation, contentHash, outputDir) {
  const providerDir = path.join(outputDir, provider.key);
  ensureDir(providerDir);

  // Write each GTFS entity file
  for (const [filename, rows] of Object.entries(data)) {
    const entityName = filename.replace('.txt', '');
    const outPath = path.join(providerDir, `${entityName}.json`);
    writeJson(outPath, rows);
  }

  // Write provider metadata
  const meta = {
    provider_key: provider.key,
    provider_name: provider.name,
    operator_group: provider.operator_group,
    mode: provider.mode,
    adapter_key: provider.adapter_key,
    gtfs_url: provider.gtfs_url,
    content_sha256: contentHash,
    processed_at: new Date().toISOString(),
    file_counts: {},
    ...validation.stats,
  };

  for (const [filename, rows] of Object.entries(data)) {
    meta.file_counts[filename] = rows.length;
  }

  writeJson(path.join(providerDir, '_meta.json'), meta);

  // Write validation report
  writeJson(path.join(providerDir, '_validation.json'), {
    provider_key: provider.key,
    content_sha256: contentHash,
    validated_at: new Date().toISOString(),
    ...validation,
  });

  // Build and write lookup indexes for API serving
  if (validation.valid || validation.stats.status !== 'invalid') {
    const indexes = buildIndexes(data);
    indexes.content_sha256 = contentHash;
    writeJson(path.join(providerDir, '_indexes.json'), indexes);
    writeSplitIndexes(providerDir, indexes);
  }

  return meta;
}

// Write each large API lookup independently. Laravel can then load only the
// section needed by an endpoint instead of decoding the full combined file.
function writeSplitIndexes(providerDir, indexes) {
  const splitDir = path.join(providerDir, '_api_indexes');
  ensureDir(splitDir);

  for (const [name, value] of Object.entries(indexes)) {
    if (name === 'generated_at' || name === 'content_sha256') continue;
    writeJson(path.join(splitDir, `${name}.json`), value);
  }

  writeJson(path.join(splitDir, '_meta.json'), {
    generated_at: indexes.generated_at,
    content_sha256: indexes.content_sha256 || null,
    sections: Object.keys(indexes).filter(name =>
      name !== 'generated_at' && name !== 'content_sha256'
    ),
  });
}

// ─── Main Processing Pipeline ────────────────────────────────────────────────

async function processProvider(provider, dataDir, outputDir) {
  console.log(`\n[${provider.key}] Processing ${provider.name}...`);

  // Step 1: Download
  const dl = await downloadFeed(provider, dataDir);
  if (!dl.success) {
    console.log(`  FAILED download: ${dl.error}`);
    return { key: provider.key, status: 'download_failed', error: dl.error };
  }

  console.log(`  Downloaded ${(dl.size / 1024).toFixed(1)} KB (hash: ${dl.hash.slice(0, 20)}...)`);

  // Step 2: Extract ZIP
  const zipBuffer = fs.readFileSync(dl.zipPath);
  const extracted = extractZip(zipBuffer);
  if (!extracted.success) {
    console.log(`  FAILED extraction: ${extracted.error}`);
    return { key: provider.key, status: 'extraction_failed', error: extracted.error };
  }

  const fileNames = Object.keys(extracted.files);
  console.log(`  Extracted ${fileNames.length} GTFS files: ${fileNames.join(', ')}`);

  // Step 3: Check core files
  const missingCore = CORE_GTFS_FILES.filter(f => !extracted.files[f]);
  if (missingCore.length > 0) {
    // Still process what we have, but mark as degraded
    console.log(`  WARNING: Missing core files: ${missingCore.join(', ')}`);
    if (missingCore.length === CORE_GTFS_FILES.length) {
      return {
        key: provider.key,
        status: 'no_core_files',
        error: `Missing all core files: ${missingCore.join(', ')}`,
        httpStatus: dl.httpStatus,
      };
    }
  }

  // Step 4: Parse CSVs
  const parsed = {};
  for (const [filename, content] of Object.entries(extracted.files)) {
    try {
      parsed[filename] = parseCsv(content);
      console.log(`  Parsed ${filename}: ${parsed[filename].length} rows`);
    } catch (err) {
      console.log(`  WARNING: Failed to parse ${filename}: ${err.message}`);
      parsed[filename] = [];
    }
  }

  // Step 4b: Provider-specific transformations
  // For rapid_bus_mrtfeeder: route_short_name = original route_long_name (TXXX code)
  //                         route_long_name = trip_headsign (descriptive name)
  if (provider.key === 'rapid_bus_mrtfeeder' && parsed['routes.txt'] && parsed['trips.txt']) {
    console.log('  Applying rapid_bus_mrtfeeder route mapping');

    // Build route_id → route map
    const routeMap = {};
    for (const route of parsed['routes.txt']) {
      routeMap[route.route_id] = route;
    }

    // Map trip_headsign to route_long_name
    // First save original route_long_name as route_short_name (the TXXX code)
    for (const trip of parsed['trips.txt']) {
      if (trip.route_id && trip.trip_headsign && routeMap[trip.route_id]) {
        const route = routeMap[trip.route_id];
        // Save original route_long_name (TXXX) as route_short_name
        if (!route.route_short_name && route.route_long_name) {
          route.route_short_name = route.route_long_name;
        }
        // Set route_long_name to trip_headsign
        route.route_long_name = trip.trip_headsign;
      }
    }
  }

  // Step 5: Validate
  const validation = validateGtfsData(parsed);
  if (validation.valid) {
    console.log(`  Validation: PASSED (${validation.warnings.length} warnings)`);
  } else {
    console.log(`  Validation: FAILED (${validation.errors.length} errors, ${validation.warnings.length} warnings)`);
    for (const err of validation.errors) {
      console.log(`    ERROR: ${err}`);
    }
  }

  // Step 6: Export JSON (even for failed validation, export what we have)
  const meta = exportProviderJson(provider, parsed, validation, dl.hash, outputDir);
  console.log(`  Exported JSON to output/${provider.key}/`);

  return {
    key: provider.key,
    status: validation.valid ? 'success' : 'validation_failed',
    hash: dl.hash,
    httpStatus: dl.httpStatus,
    size: dl.size,
    stats: validation.stats,
    errors: validation.errors,
    warnings: validation.warnings,
    meta,
  };
}

// ─── Aggregate Export ─────────────────────────────────────────────────────────

function exportAggregate(results, outputDir) {
  // Build national summary
  const summary = {
    generated_at: new Date().toISOString(),
    total_providers: results.length,
    successful: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status !== 'success' && r.status !== 'skipped').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    providers: results.map(r => ({
      provider_key: r.key,
      status: r.status,
      content_sha256: r.hash || null,
      stats: r.stats || null,
      errors: r.errors || [],
      warnings: r.warnings || [],
    })),
  };

  writeJson(path.join(outputDir, '_summary.json'), summary);

  // Build national indexes for cross-provider lookups
  const nationalStops = [];
  const nationalRoutes = [];
  const nationalAgencies = [];

  for (const result of results) {
    if (result.status === 'skipped') continue;

    const providerDir = path.join(outputDir, result.key);
    if (!fs.existsSync(providerDir)) continue;

    // Load stops
    const stopsPath = path.join(providerDir, 'stops.json');
    if (fs.existsSync(stopsPath)) {
      const stops = JSON.parse(fs.readFileSync(stopsPath, 'utf-8'));
      for (const stop of stops) {
        nationalStops.push({
          provider_key: result.key,
          ...stop,
        });
      }
    }

    // Load routes
    const routesPath = path.join(providerDir, 'routes.json');
    if (fs.existsSync(routesPath)) {
      const routes = JSON.parse(fs.readFileSync(routesPath, 'utf-8'));
      for (const route of routes) {
        nationalRoutes.push({
          provider_key: result.key,
          ...route,
        });
      }
    }

    // Load agencies
    const agencyPath = path.join(providerDir, 'agency.json');
    if (fs.existsSync(agencyPath)) {
      const agencies = JSON.parse(fs.readFileSync(agencyPath, 'utf-8'));
      for (const agency of agencies) {
        nationalAgencies.push({
          provider_key: result.key,
          ...agency,
        });
      }
    }
  }

  writeJson(path.join(outputDir, 'national_stops.json'), nationalStops);
  writeJson(path.join(outputDir, 'national_routes.json'), nationalRoutes);
  writeJson(path.join(outputDir, 'national_agencies.json'), nationalAgencies);

  return summary;
}

// ─── Index Builder ────────────────────────────────────────────────────────────
// Builds lookup indexes for fast API serving. Exported as _indexes.json per provider.

function buildIndexes(data) {
  const indexes = {
    generated_at: new Date().toISOString(),

    // trip_id → route + service info (for realtime matching)
    trip_to_route: {},

    // stop_id → [{route_id, route_short_name, route_type, stop_sequence, direction_id}]
    stop_to_routes: {},

    // route_id → [{stop_id, stop_name, stop_sequence, direction_id}]
    route_to_stops: {},

    // stop_id → [{trip_id, arrival_time, departure_time, stop_sequence}]
    stop_times_by_stop: {},

    // trip_id → [{stop_id, stop_name, arrival_time, departure_time, stop_sequence}]
    stop_times_by_trip: {},

    // date (YYYYMMDD) → [service_id, ...]
    service_dates: {},

    // trip_id → {route_id, route_short_name, service_id, direction_id, shape_id, stop_count, first_stop, last_stop}
    trip_details: {},

    // route_id → [{trip_id, service_id, direction_id}]
    route_trips: {},

    // trip_id → [{start_time, end_time, headway_secs, exact_times}]
    frequencies_by_trip: {},
  };

  const trips = data['trips.txt'] || [];
  const routes = data['routes.txt'] || [];
  const stops = data['stops.txt'] || [];
  const stopTimes = data['stop_times.txt'] || [];
  const calendar = data['calendar.txt'] || [];
  const calendarDates = data['calendar_dates.txt'] || [];
  const frequencies = data['frequencies.txt'] || [];

  // Build route lookup map
  const routeMap = {};
  for (const r of routes) {
    routeMap[r.route_id] = r;
  }

  // Build stop lookup map
  const stopMap = {};
  for (const s of stops) {
    stopMap[s.stop_id] = s;
  }

  // ── 1. trip_to_route ──
  for (const trip of trips) {
    const route = routeMap[trip.route_id];
    indexes.trip_to_route[trip.trip_id] = {
      route_id: trip.route_id || null,
      route_short_name: route ? route.route_short_name : null,
      route_long_name: route ? route.route_long_name : null,
      route_type: route ? route.route_type : null,
      service_id: trip.service_id || null,
      direction_id: trip.direction_id || null,
      shape_id: trip.shape_id || null,
      trip_headsign: trip.trip_headsign || null,
    };
  }

  // ── 2. stop_times_by_stop ──
  for (const st of stopTimes) {
    if (!st.stop_id) continue;
    if (!indexes.stop_times_by_stop[st.stop_id]) {
      indexes.stop_times_by_stop[st.stop_id] = [];
    }
    indexes.stop_times_by_stop[st.stop_id].push({
      trip_id: st.trip_id,
      arrival_time: st.arrival_time,
      departure_time: st.departure_time,
      stop_sequence: st.stop_sequence,
    });
  }

  // ── 3. stop_times_by_trip ──
  for (const st of stopTimes) {
    if (!st.trip_id) continue;
    if (!indexes.stop_times_by_trip[st.trip_id]) {
      indexes.stop_times_by_trip[st.trip_id] = [];
    }
    indexes.stop_times_by_trip[st.trip_id].push({
      stop_id: st.stop_id,
      stop_name: stopMap[st.stop_id] ? stopMap[st.stop_id].stop_name : null,
      arrival_time: st.arrival_time,
      departure_time: st.departure_time,
      stop_sequence: st.stop_sequence,
    });
  }

  // Sort stop_times_by_trip by stop_sequence
  for (const tripId in indexes.stop_times_by_trip) {
    indexes.stop_times_by_trip[tripId].sort((a, b) => {
      return parseInt(a.stop_sequence) - parseInt(b.stop_sequence);
    });
  }

  // ── 4. stop_to_routes ──
  // For each stop, find all routes that serve it via stop_times→trips→routes
  const stopRouteMap = {}; // stop_id → Map(route_id → info)
  for (const st of stopTimes) {
    if (!st.stop_id || !st.trip_id) continue;
    const tripInfo = indexes.trip_to_route[st.trip_id];
    if (!tripInfo || !tripInfo.route_id) continue;

    if (!stopRouteMap[st.stop_id]) {
      stopRouteMap[st.stop_id] = {};
    }
    if (!stopRouteMap[st.stop_id][tripInfo.route_id]) {
      stopRouteMap[st.stop_id][tripInfo.route_id] = {
        route_id: tripInfo.route_id,
        route_short_name: tripInfo.route_short_name,
        route_type: tripInfo.route_type,
        stop_sequence: st.stop_sequence,
        direction_id: tripInfo.direction_id,
      };
    }
  }
  for (const stopId in stopRouteMap) {
    indexes.stop_to_routes[stopId] = Object.values(stopRouteMap[stopId]);
  }

  // ── 5. route_to_stops ──
  // For each route, find all stops ordered by trip+sequence
  const routeStopMap = {}; // route_id → Map(stop_id → ordered info)
  for (const trip of trips) {
    if (!trip.route_id) continue;
    const tripStops = indexes.stop_times_by_trip[trip.trip_id] || [];
    if (!routeStopMap[trip.route_id]) {
      routeStopMap[trip.route_id] = {};
    }
    for (let i = 0; i < tripStops.length; i++) {
      const ts = tripStops[i];
      const key = `${ts.stop_id}_${trip.direction_id || 'null'}`;
      if (!routeStopMap[trip.route_id][key]) {
        routeStopMap[trip.route_id][key] = {
          stop_id: ts.stop_id,
          stop_name: ts.stop_name,
          stop_sequence: ts.stop_sequence,
          direction_id: trip.direction_id || null,
        };
      }
    }
  }
  for (const routeId in routeStopMap) {
    indexes.route_to_stops[routeId] = Object.values(routeStopMap[routeId])
      .sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));
  }

  // ── 6. service_dates ──
  // Materialize calendar + calendar_dates into date→services map
  // Covers a 60-day window from today
  const today = new Date();
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  for (let d = -1; d <= 60; d++) {
    const date = new Date(today);
    date.setDate(date.getDate() + d);
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const dayName = DAY_NAMES[date.getDay()];

    const activeServices = [];

    // Check calendar.txt
    for (const cal of calendar) {
      if (cal.start_date && cal.end_date &&
          dateStr >= cal.start_date && dateStr <= cal.end_date &&
          cal[dayName] === '1') {
        activeServices.push(cal.service_id);
      }
    }

    // Apply calendar_dates.txt exceptions
    for (const cd of calendarDates) {
      if (cd.date === dateStr) {
        if (cd.exception_type === '1') {
          // Addition
          if (!activeServices.includes(cd.service_id)) {
            activeServices.push(cd.service_id);
          }
        } else if (cd.exception_type === '2') {
          // Removal
          const idx = activeServices.indexOf(cd.service_id);
          if (idx !== -1) {
            activeServices.splice(idx, 1);
          }
        }
      }
    }

    if (activeServices.length > 0) {
      indexes.service_dates[dateStr] = activeServices;
    }
  }

  // If no calendar.txt, use calendar_dates.txt as complete service list
  if (calendar.length === 0 && calendarDates.length > 0) {
    const dateServiceMap = {};
    for (const cd of calendarDates) {
      if (cd.exception_type === '1' && cd.date) {
        if (!dateServiceMap[cd.date]) {
          dateServiceMap[cd.date] = [];
        }
        if (!dateServiceMap[cd.date].includes(cd.service_id)) {
          dateServiceMap[cd.date].push(cd.service_id);
        }
      }
    }
    Object.assign(indexes.service_dates, dateServiceMap);
  }

  // ── 7. trip_details ──
  for (const trip of trips) {
    const tripStops = indexes.stop_times_by_trip[trip.trip_id] || [];
    const route = routeMap[trip.route_id];
    const firstStop = tripStops.length > 0 ? tripStops[0] : null;
    const lastStop = tripStops.length > 0 ? tripStops[tripStops.length - 1] : null;

    indexes.trip_details[trip.trip_id] = {
      route_id: trip.route_id || null,
      route_short_name: route ? route.route_short_name : null,
      service_id: trip.service_id || null,
      direction_id: trip.direction_id || null,
      shape_id: trip.shape_id || null,
      trip_headsign: trip.trip_headsign || null,
      stop_count: tripStops.length,
      first_stop: firstStop ? {
        stop_id: firstStop.stop_id,
        stop_name: firstStop.stop_name,
        departure_time: firstStop.departure_time,
      } : null,
      last_stop: lastStop ? {
        stop_id: lastStop.stop_id,
        stop_name: lastStop.stop_name,
        arrival_time: lastStop.arrival_time,
      } : null,
    };
  }

  // ── 8. route_trips ──
  for (const trip of trips) {
    if (!trip.route_id) continue;
    if (!indexes.route_trips[trip.route_id]) {
      indexes.route_trips[trip.route_id] = [];
    }
    indexes.route_trips[trip.route_id].push({
      trip_id: trip.trip_id,
      service_id: trip.service_id,
      direction_id: trip.direction_id || null,
    });
  }

  // ── 9. frequencies_by_trip ──
  for (const freq of frequencies) {
    if (!freq.trip_id) continue;
    if (!indexes.frequencies_by_trip[freq.trip_id]) {
      indexes.frequencies_by_trip[freq.trip_id] = [];
    }
    indexes.frequencies_by_trip[freq.trip_id].push({
      start_time: freq.start_time,
      end_time: freq.end_time,
      headway_secs: freq.headway_secs,
      exact_times: freq.exact_times || '0',
    });
  }

  return indexes;
}

// ─── Provider Registry Export ─────────────────────────────────────────────────

// Providers without realtime feeds
const NO_REALTIME_PROVIDERS = new Set(['rapid_rail_kl']);

function exportProvidersJson(providers, outputDir) {
  const providersList = providers.map((p, idx) => ({
    provider_id: idx + 1,
    provider_key: p.key,
    provider_name: p.name,
    operator_group: p.operator_group,
    mode: p.mode,
    category_key: p.category_key,
    source_category: p.source_category,
    adapter_key: p.adapter_key,
    gtfs_url: p.gtfs_url,
    has_realtime: !NO_REALTIME_PROVIDERS.has(p.key),
  }));

  writeJson(path.join(outputDir, '_providers.json'), providersList);
  return providersList;
}

module.exports = {
  processProvider,
  exportAggregate,
  exportProvidersJson,
  extractZip,
  parseCsv,
  validateGtfsData,
  buildIndexes,
};
