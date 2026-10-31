import type { LatLon } from '../core/geo';
import { LANES } from '../core/simulator';
import type { Port, RouteTemplate } from './types';

/** Port master data (approximate coordinates). */
export const PORTS: Port[] = [
  { id: 'INBOM', name: 'Mumbai (Nhava Sheva)', country: 'India', lat: 18.95, lon: 72.95 },
  { id: 'INMUN', name: 'Mundra', country: 'India', lat: 22.74, lon: 69.7 },
  { id: 'INKDL', name: 'Kandla', country: 'India', lat: 23.0, lon: 70.22 },
  { id: 'INCOK', name: 'Kochi', country: 'India', lat: 9.97, lon: 76.27 },
  { id: 'INMAA', name: 'Chennai', country: 'India', lat: 13.09, lon: 80.3 },
  { id: 'INVTZ', name: 'Visakhapatnam', country: 'India', lat: 17.69, lon: 83.3 },
  { id: 'INCCU', name: 'Kolkata / Haldia', country: 'India', lat: 22.03, lon: 88.07 },
  { id: 'INIXY', name: 'Port Blair', country: 'India', lat: 11.68, lon: 92.74 },
  { id: 'LKCMB', name: 'Colombo', country: 'Sri Lanka', lat: 6.95, lon: 79.85 },
  { id: 'PKKHI', name: 'Karachi', country: 'Pakistan', lat: 24.84, lon: 66.98 },
  { id: 'AEFJR', name: 'Fujairah', country: 'UAE', lat: 25.17, lon: 56.36 },
  { id: 'AEJEA', name: 'Jebel Ali', country: 'UAE', lat: 25.0, lon: 55.06 },
  { id: 'YEADE', name: 'Aden', country: 'Yemen', lat: 12.79, lon: 45.03 },
  { id: 'DJJIB', name: 'Djibouti', country: 'Djibouti', lat: 11.6, lon: 43.14 },
  { id: 'BDCGP', name: 'Chittagong', country: 'Bangladesh', lat: 22.3, lon: 91.8 },
  { id: 'SGSIN', name: 'Singapore', country: 'Singapore', lat: 1.26, lon: 103.84 },
  { id: 'MYPKG', name: 'Port Klang', country: 'Malaysia', lat: 3.0, lon: 101.4 },
];

const lane = (id: keyof typeof LANES, reverse = false): LatLon[] => {
  const pts = LANES[id] as LatLon[];
  return reverse ? [...pts].reverse() : [...pts];
};

/**
 * Pre-validated open-water route templates (the same lanes used by the synthetic traffic, checked against land).
 * Production would use a routing engine; templates keep the risk screening deterministic and testable.
 */
export const ROUTE_TEMPLATES: RouteTemplate[] = [
  { id: 'mumbai-aden', name: 'Mumbai → Gulf of Aden (via Arabian Sea)', from: 'INBOM', to: 'YEADE', waypoints: lane('adenMumbai', true) },
  { id: 'aden-mumbai', name: 'Gulf of Aden → Mumbai', from: 'YEADE', to: 'INBOM', waypoints: lane('adenMumbai') },
  { id: 'mumbai-fujairah', name: 'Mumbai → Fujairah (Hormuz approaches)', from: 'INBOM', to: 'AEFJR', waypoints: lane('mumbaiGulf') },
  { id: 'mumbai-kochi', name: 'Mumbai → Kochi (west coast)', from: 'INBOM', to: 'INCOK', waypoints: lane('mumbaiKochi') },
  { id: 'mumbai-mundra', name: 'Mumbai → Mundra / Kandla', from: 'INBOM', to: 'INMUN', waypoints: lane('mumbaiKandla') },
  { id: 'kochi-colombo', name: 'Kochi → Colombo', from: 'INCOK', to: 'LKCMB', waypoints: lane('kochiSouth') },
  { id: 'chennai-colombo', name: 'Chennai → Colombo', from: 'INMAA', to: 'LKCMB', waypoints: lane('chennaiColombo') },
  { id: 'kolkata-chennai', name: 'Kolkata → Chennai (east coast)', from: 'INCCU', to: 'INMAA', waypoints: lane('kolkataChennai') },
  { id: 'chennai-portblair', name: 'Chennai → Port Blair', from: 'INMAA', to: 'INIXY', waypoints: lane('chennaiPortBlair') },
  { id: 'colombo-malacca', name: 'Colombo → Malacca Strait / Singapore', from: 'LKCMB', to: 'SGSIN', waypoints: lane('colomboMalacca') },
  { id: 'aden-colombo', name: 'Gulf of Aden → Colombo (Indian Ocean)', from: 'YEADE', to: 'LKCMB', waypoints: lane('adenColombo') },
  { id: 'chittagong-colombo', name: 'Chittagong → Colombo (Bay of Bengal)', from: 'BDCGP', to: 'LKCMB', waypoints: lane('chittagongColombo') },
];

export const portById = (id: string): Port | undefined => PORTS.find((p) => p.id === id);
export const routeTemplateById = (id: string): RouteTemplate | undefined => ROUTE_TEMPLATES.find((r) => r.id === id);
