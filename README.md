# Malaysia GTFS Static Preprocessor

Node.js tool that downloads and parses all 16 documented GTFS static feeds from [data.gov.my](https://developer.data.gov.my/realtime-api/gtfs-static) into usable JSON.

## Quick Start

```bash
npm install
npm start
```

## What It Does

1. **Downloads** all 16 Malaysia GTFS static feeds (rate-limited to 4 req/min)
2. **Extracts** ZIP files safely (path traversal protection, macOS `__MACOSX` filtering)
3. **Parses** CSV files with proper quoting, BOM handling, header-case preservation
4. **Validates** referential integrity (routes→trips→stop_times→stops)
5. **Exports** per-provider JSON + national aggregate + manifest

## Providers (16 feeds)

| Key | Operator | Mode |
|-----|----------|------|
| `ktmb` | KTM Berhad | Rail |
| `rapid_bus_penang` | Prasarana | Bus |
| `rapid_bus_kuantan` | Prasarana | Bus |
| `rapid_bus_mrtfeeder` | Prasarana | Bus |
| `rapid_rail_kl` | Prasarana | Rail |
| `rapid_bus_kl` | Prasarana | Bus |
| `mybas_kangar` | BAS.MY | Bus |
| `mybas_alor_setar` | BAS.MY | Bus |
| `mybas_kota_bharu` | BAS.MY | Bus |
| `mybas_kuala_terengganu` | BAS.MY | Bus |
| `mybas_ipoh` | BAS.MY | Bus |
| `mybas_seremban_a` | BAS.MY | Bus |
| `mybas_seremban_b` | BAS.MY | Bus |
| `mybas_melaka` | BAS.MY | Bus |
| `mybas_johor` | BAS.MY | Bus |
| `mybas_kuching` | BAS.MY | Bus |

## Output Structure

```
output/
├── manifest.json              SHA-256 hashes for all providers
├── _summary.json              National processing summary
├── national_stops.json        All stops across providers
├── national_routes.json       All routes across providers
├── national_agencies.json     All agencies across providers
├── rapid_bus_kl/
│   ├── _meta.json             Provider metadata and stats
│   ├── _validation.json       Validation errors/warnings
│   ├── agency.json
│   ├── stops.json
│   ├── routes.json
│   ├── trips.json
│   ├── stop_times.json
│   ├── calendar.json
│   ├── calendar_dates.json
│   ├── shapes.json
│   └── frequencies.json
├── ktmb/
│   └── ...
└── ... (16 provider directories)
```

## CLI Options

```bash
# Process all providers
node index.js

# Process single provider
node index.js --provider rapid_bus_kl

# Verbose output
node index.js --verbose

# Skip downloads (use cached ZIPs)
node index.js --skip-download
```

## Data Caching

- Downloaded ZIPs are stored in `data/zips/` with content-hash filenames
- A hash tracking file (`data/processed_hashes.json`) enables incremental processing
- Unchanged feeds are skipped automatically

## Validation

Each provider gets a `_validation.json` with:
- **Errors**: Missing core files, broken referential integrity, empty critical files
- **Warnings**: Missing optional files (shapes, feed_info), expired calendars, extension columns

## Rate Limiting

Respects data.gov.my's published quota of 4 GTFS Static requests per minute. Uses 16-second intervals between requests.

## Security

- ZIP signature verification (PK\x03\x04)
- Path traversal prevention (only allowed GTFS filenames)
- macOS `__MACOSX`/AppleDouble file filtering
- Compression bomb detection (ratio > 100x)
- Max file size limits (100MB download, 500MB extracted)
