/** Normalisation of raw AIS position reports into the unified Vessel model. */
import { isValidCoord } from './geo';
import type { PositionReport, Vessel, VesselCategory } from './types';

export const TRAIL_LENGTH = 24;

/** AIS ship-type code (ITU-R M.1371) → category. Order matters: specific codes first. */
export function categoryFromShipType(code: number | undefined): VesselCategory {
  if (code === undefined || !Number.isFinite(code)) return 'other';
  if (code === 35) return 'naval';
  if (code === 55) return 'coast_guard'; // law enforcement
  if (code === 30) return 'fishing';
  if (code >= 40 && code <= 49) return 'highspeed';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 31 && code <= 32) return 'other'; // towing
  return 'other';
}

/** Maritime Identification Digits (first 3 digits of MMSI) → flag state. */
const MID_TO_FLAG: Record<string, string> = {
  '201': 'Albania', '205': 'Belgium', '209': 'Cyprus', '210': 'Cyprus', '211': 'Germany', '218': 'Germany',
  '219': 'Denmark', '220': 'Denmark', '224': 'Spain', '225': 'Spain', '226': 'France', '227': 'France',
  '228': 'France', '229': 'Malta', '232': 'UK', '233': 'UK', '234': 'UK', '235': 'UK', '236': 'Gibraltar',
  '237': 'Greece', '238': 'Croatia', '239': 'Greece', '240': 'Greece', '241': 'Greece', '244': 'Netherlands',
  '245': 'Netherlands', '246': 'Netherlands', '247': 'Italy', '248': 'Malta', '249': 'Malta', '250': 'Ireland',
  '255': 'Portugal', '256': 'Malta', '257': 'Norway', '258': 'Norway', '259': 'Norway', '265': 'Sweden',
  '266': 'Sweden', '271': 'Turkey', '272': 'Ukraine', '273': 'Russia', '275': 'Latvia', '276': 'Estonia',
  '277': 'Lithuania', '278': 'Slovenia', '303': 'USA', '308': 'Bahamas', '309': 'Bahamas', '311': 'Bahamas',
  '314': 'Barbados', '319': 'Cayman Islands', '338': 'USA', '351': 'Panama', '352': 'Panama', '353': 'Panama',
  '354': 'Panama', '355': 'Panama', '356': 'Panama', '357': 'Panama', '370': 'Panama', '371': 'Panama',
  '372': 'Panama', '373': 'Panama', '374': 'Panama', '403': 'Saudi Arabia', '405': 'Bangladesh', '408': 'Bahrain',
  '412': 'China', '413': 'China', '414': 'China', '416': 'Taiwan', '419': 'India', '422': 'Iran', '425': 'Iraq',
  '428': 'Israel', '431': 'Japan', '432': 'Japan', '440': 'South Korea', '441': 'South Korea',
  '445': 'North Korea', '447': 'Kuwait', '450': 'Lebanon', '451': 'Kyrgyzstan', '453': 'Macao', '455': 'Maldives',
  '457': 'Mongolia', '459': 'Nepal', '461': 'Oman', '463': 'Pakistan', '466': 'Qatar', '468': 'Syria',
  '470': 'UAE', '471': 'UAE', '472': 'Tajikistan', '473': 'Yemen', '475': 'Yemen', '477': 'Hong Kong',
  '503': 'Australia', '506': 'Myanmar', '508': 'Brunei', '510': 'Micronesia', '511': 'Palau', '512': 'New Zealand',
  '514': 'Cambodia', '515': 'Cambodia', '520': 'Fiji', '525': 'Indonesia', '533': 'Malaysia', '538': 'Marshall Islands',
  '542': 'Niue', '544': 'Nauru', '548': 'Philippines', '553': 'Papua New Guinea', '563': 'Singapore',
  '564': 'Singapore', '565': 'Singapore', '566': 'Singapore', '567': 'Thailand', '570': 'Tonga', '574': 'Vietnam',
  '576': 'Vanuatu', '577': 'Vanuatu', '601': 'South Africa', '605': 'Algeria', '610': 'Benin', '613': 'Cameroon',
  '620': 'Comoros', '622': 'Egypt', '624': 'Ethiopia', '627': 'Ghana', '634': 'Kenya', '636': 'Liberia',
  '637': 'Liberia', '642': 'Libya', '645': 'Mauritius', '647': 'Madagascar', '649': 'Mali', '650': 'Mozambique',
  '654': 'Mauritania', '656': 'Niger', '657': 'Nigeria', '659': 'Namibia', '660': 'Reunion', '661': 'Rwanda',
  '662': 'Sudan', '663': 'Senegal', '664': 'Seychelles', '666': 'Somalia', '667': 'Sierra Leone', '668': 'Sao Tome',
  '669': 'Eswatini', '670': 'Chad', '671': 'Togo', '672': 'Tunisia', '674': 'Tanzania', '675': 'Uganda',
  '676': 'DR Congo', '677': 'Tanzania', '678': 'Zambia', '679': 'Zimbabwe', '701': 'Argentina', '710': 'Brazil',
  '725': 'Chile', '730': 'Colombia', '735': 'Ecuador', '760': 'Peru', '770': 'Uruguay', '775': 'Venezuela',
  '417': 'Sri Lanka',
};

export function flagFromMmsi(mmsi: string): string {
  return MID_TO_FLAG[mmsi.slice(0, 3)] ?? 'Unknown';
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Validate and normalise a position report. Returns null for reports that must
 * not enter the store (bad MMSI, null island, out-of-range, non-finite).
 */
export function normalizeReport(r: PositionReport, now: number = Date.now()): Vessel | null {
  if (!/^\d{9}$/.test(r.mmsi)) return null;
  if (!isValidCoord(r.lat, r.lon)) return null;
  if (r.lat === 0 && r.lon === 0) return null;
  const sog = r.sog === undefined || !Number.isFinite(r.sog) ? 0 : r.sog;
  if (sog < 0 || sog > 102.2) return null; // 102.3 = "not available" in AIS
  const cog = r.cog !== undefined && Number.isFinite(r.cog) && r.cog >= 0 && r.cog < 360 ? r.cog : 0;
  const heading =
    r.heading !== undefined && Number.isFinite(r.heading) && r.heading >= 0 && r.heading < 360 ? r.heading : cog;
  const name = (r.name ?? '').replace(/[^\x20-\x7e]/g, '').trim();
  return {
    mmsi: r.mmsi,
    origin: r.synthetic ? 'synthetic' : 'ais',
    name: name || `MMSI ${r.mmsi}`,
    lat: r.lat,
    lon: r.lon,
    sog: clamp(sog, 0, 102.2),
    cog,
    heading,
    category: categoryFromShipType(r.shipType),
    flag: flagFromMmsi(r.mmsi),
    lastSeen: r.ts !== undefined && Number.isFinite(r.ts) ? r.ts : now,
    trail: [],
  };
}
