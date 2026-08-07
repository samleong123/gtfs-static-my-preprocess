// Malaysia GTFS Static Feed Providers
// 15 active logical feeds from data.gov.my
// rapid_bus_kuantan removed: service discontinued, returns HTTP 404
// Source: https://developer.data.gov.my/realtime-api/gtfs-static

const BASE_URL = 'https://api.data.gov.my/gtfs-static';

const PROVIDERS = [
  {
    key: 'ktmb',
    name: 'KTM Berhad',
    operator_group: 'ktmb',
    mode: 'rail',
    category_key: 'ktmb',
    source_category: null,
    adapter_key: 'ktmb',
    gtfs_url: `${BASE_URL}/ktmb`,
    notes: 'Rail. Realtime may supply trip_id but not route_id; derive route from static trip.'
  },
  {
    key: 'rapid_bus_penang',
    name: 'Rapid Penang Bus',
    operator_group: 'prasarana',
    mode: 'bus',
    category_key: 'rapid_bus_penang',
    source_category: 'rapid-bus-penang',
    adapter_key: 'prasarana_penang',
    gtfs_url: `${BASE_URL}/prasarana?category=rapid-bus-penang`,
    notes: 'Realtime route values may be public route names rather than static route_id.'
  },
  {
    key: 'rapid_bus_mrtfeeder',
    name: 'Rapid KL MRT Feeder Bus',
    operator_group: 'prasarana',
    mode: 'bus',
    category_key: 'rapid_bus_mrtfeeder',
    source_category: 'rapid-bus-mrtfeeder',
    adapter_key: 'prasarana_mrtfeeder',
    gtfs_url: `${BASE_URL}/prasarana?category=rapid-bus-mrtfeeder`,
    notes: 'Agency row may omit agency_id. Realtime route values can be public codes like T505.'
  },
  {
    key: 'rapid_rail_kl',
    name: 'Rapid KL Rail',
    operator_group: 'prasarana',
    mode: 'rail',
    category_key: 'rapid_rail_kl',
    source_category: 'rapid-rail-kl',
    adapter_key: 'prasarana_rail_extended',
    gtfs_url: `${BASE_URL}/prasarana?category=rapid-rail-kl`,
    notes: 'No stable realtime endpoint. Contains __MACOSX packaging entries. Non-standard columns.'
  },
  {
    key: 'rapid_bus_kl',
    name: 'Rapid KL Bus',
    operator_group: 'prasarana',
    mode: 'bus',
    category_key: 'rapid_bus_kl',
    source_category: 'rapid-bus-kl',
    adapter_key: 'prasarana_bus_frequency',
    gtfs_url: `${BASE_URL}/prasarana?category=rapid-bus-kl`,
    notes: 'Strong static/realtime linkage. ~2% trips removed from stop_times.txt. Large frequencies.txt.'
  },
  {
    key: 'mybas_kangar',
    name: 'myBAS Kangar',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_kangar',
    source_category: 'mybas-kangar',
    adapter_key: 'bas_my_legacy',
    gtfs_url: `${BASE_URL}/mybas-kangar`,
    notes: 'Legacy schema. Realtime trip descriptors may only be present on some vehicles.'
  },
  {
    key: 'mybas_alor_setar',
    name: 'myBAS Alor Setar',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_alor_setar',
    source_category: 'mybas-alor-setar',
    adapter_key: 'bas_my_legacy',
    gtfs_url: `${BASE_URL}/mybas-alor-setar`,
    notes: 'Audit observed zero-byte static object. Never promote empty body.'
  },
  {
    key: 'mybas_kota_bharu',
    name: 'myBAS Kota Bharu',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_kota_bharu',
    source_category: 'mybas-kota-bharu',
    adapter_key: 'bas_my_legacy',
    gtfs_url: `${BASE_URL}/mybas-kota-bharu`,
    notes: 'Realtime may have no usable trip or route descriptor.'
  },
  {
    key: 'mybas_kuala_terengganu',
    name: 'myBAS Kuala Terengganu',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_kuala_terengganu',
    source_category: 'mybas-kuala-terengganu',
    adapter_key: 'bas_my_legacy',
    gtfs_url: `${BASE_URL}/mybas-kuala-terengganu`,
    notes: 'Realtime may have no usable trip or route descriptor.'
  },
  {
    key: 'mybas_ipoh',
    name: 'myBAS Ipoh',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_ipoh',
    source_category: 'mybas-ipoh',
    adapter_key: 'bas_my_nssit',
    gtfs_url: `${BASE_URL}/mybas-ipoh`,
    notes: 'Audit observed expired service and empty realtime. Health must be dynamic.'
  },
  {
    key: 'mybas_seremban_a',
    name: 'myBAS Seremban (Operator A)',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_seremban_a',
    source_category: 'mybas-seremban-a',
    adapter_key: 'bas_my_nssit',
    gtfs_url: `${BASE_URL}/mybas-seremban-a`,
    notes: 'One of two Seremban feeds. Trip-ID mismatch observed; route/stop linkage found.'
  },
  {
    key: 'mybas_seremban_b',
    name: 'myBAS Seremban (Operator B)',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_seremban_b',
    source_category: 'mybas-seremban-b',
    adapter_key: 'bas_my_nssit',
    gtfs_url: `${BASE_URL}/mybas-seremban-b`,
    notes: 'Second Seremban operator. Do not merge with A without retaining feed namespace.'
  },
  {
    key: 'mybas_melaka',
    name: 'myBAS Melaka',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_melaka',
    source_category: 'mybas-melaka',
    adapter_key: 'bas_my_causeway_link',
    gtfs_url: `${BASE_URL}/mybas-melaka`,
    notes: 'Modern profile with GTFS Fares v2. Good static/realtime linkage.'
  },
  {
    key: 'mybas_johor',
    name: 'myBAS Johor',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_johor',
    source_category: 'mybas-johor',
    adapter_key: 'bas_my_causeway_link',
    gtfs_url: `${BASE_URL}/mybas-johor`,
    notes: 'Modern profile with GTFS Fares v2. Good static/realtime linkage.'
  },
  {
    key: 'mybas_kuching',
    name: 'myBAS Kuching',
    operator_group: 'bas_my',
    mode: 'bus',
    category_key: 'mybas_kuching',
    source_category: 'mybas-kuching',
    adapter_key: 'bas_my_legacy',
    gtfs_url: `${BASE_URL}/mybas-kuching`,
    notes: 'Legacy schema. Realtime can lack trip and route descriptor.'
  }
];

module.exports = { PROVIDERS };
