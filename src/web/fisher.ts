/**
 * Public "Boundary Safety" screen for fishermen and small-boat owners.
 * Offline-first: the check is computed on-device with the same core code the server uses,
 * using the phone's GPS — no AIS transponder, login or network required.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { checkBoundary, type BoundaryStatus } from '../core/boundary';
import { isValidCoord } from '../core/geo';
import { addBaseLayer, addZoneLayers } from './map';
import { $, clear, h } from './dom';
import { LANGS, t, type Lang } from './i18n';

const LEVEL_ICON: Record<BoundaryStatus['level'], string> = { safe: '✔', caution: '⚠', danger: '⚠', crossed: '✖' };
const NM_TO_KM = 1.852;

function zoneTextFor(lang: Lang, s: BoundaryStatus): string {
  switch (s.zone) {
    case 'territorial': return t(lang, 'zTerritorial');
    case 'contiguous': return t(lang, 'zContiguous');
    case 'eez': return t(lang, 'zEez');
    case 'foreign': return t(lang, 'zForeign').replace('{country}', s.country ?? '');
    default: return t(lang, 'zHighSeas');
  }
}

export function mountFisher(root: HTMLElement, onBack: () => void): void {
  let lang: Lang = (['en', 'hi', 'gu'] as const).find((l) => l === localStorage.getItem('orvms_lang')) ?? 'en';
  let status: BoundaryStatus | null = null;
  let message = '';
  let updatedAt = 0;
  let map: L.Map | undefined;
  let watchId: number | undefined;
  let lastPos: [number, number] | null = null;

  const setLang = (l: Lang): void => {
    lang = l;
    try {
      localStorage.setItem('orvms_lang', l);
    } catch {
      /* storage unavailable */
    }
    render();
  };

  const apply = (lat: number, lon: number): void => {
    const s = checkBoundary(lat, lon);
    if (!s) {
      message = t(lang, 'invalid');
      status = null;
    } else {
      status = s;
      message = '';
      lastPos = [lat, lon];
      updatedAt = Date.now();
    }
    render();
  };

  const locate = (): void => {
    if (!('geolocation' in navigator)) {
      message = t(lang, 'unsupported');
      render();
      return;
    }
    message = t(lang, 'locating');
    render();
    if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
      (p) => apply(p.coords.latitude, p.coords.longitude),
      (err) => {
        message = err.code === err.PERMISSION_DENIED ? t(lang, 'denied') : t(lang, 'unsupported');
        render();
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
  };

  const render = (): void => {
    map?.remove();
    map = undefined;
    clear(root);

    const latIn = h('input', { id: 'f-lat', type: 'number', step: 'any', inputmode: 'decimal', value: lastPos ? lastPos[0].toFixed(4) : '' });
    const lonIn = h('input', { id: 'f-lon', type: 'number', step: 'any', inputmode: 'decimal', value: lastPos ? lastPos[1].toFixed(4) : '' });

    const statusCard = status
      ? h(
          'div',
          { class: `fisher-status level-${status.level}`, role: 'status', 'aria-live': 'assertive' },
          h('div', { class: 'fisher-icon', 'aria-hidden': 'true' }, LEVEL_ICON[status.level]),
          h('div', { class: 'fisher-msg' }, t(lang, status.level)),
          h(
            'div',
            { class: 'fisher-dist' },
            `${t(lang, 'distance')}: `,
            h('strong', {}, `${status.distanceNm} nm`),
            ` (${(status.distanceNm * NM_TO_KM).toFixed(1)} km)`,
          ),
          h('div', { class: 'fisher-zone' }, `${t(lang, 'youAreIn')}: ${zoneTextFor(lang, status)}`),
          h('div', { class: 'muted' }, `${t(lang, 'updated')}: ${new Date(updatedAt).toLocaleTimeString()}`),
        )
      : null;

    root.append(
      h(
        'div',
        { class: 'fisher' },
        h(
          'header',
          { class: 'fisher-head' },
          h('button', { class: 'btn ghost', onclick: () => { stop(); onBack(); } }, '← ' + t(lang, 'back')),
          h(
            'div',
            { class: 'lang', role: 'group', 'aria-label': 'Language' },
            ...LANGS.map((l) =>
              h('button', { class: `btn small ${l.code === lang ? 'active' : ''}`, 'aria-pressed': String(l.code === lang), onclick: () => setLang(l.code) }, l.label),
            ),
          ),
        ),
        h('h1', {}, t(lang, 'title')),
        h('p', { class: 'muted' }, t(lang, 'subtitle')),
        h('button', { class: 'btn primary xl', onclick: locate }, '📍 ' + t(lang, 'useLocation')),
        message ? h('p', { class: 'fisher-note', role: 'status' }, message) : null,
        statusCard,
        h(
          'form',
          {
            class: 'fisher-form',
            onsubmit: (e: Event) => {
              e.preventDefault();
              const lat = parseFloat((latIn as HTMLInputElement).value);
              const lon = parseFloat((lonIn as HTMLInputElement).value);
              if (isValidCoord(lat, lon)) apply(lat, lon);
              else {
                message = t(lang, 'invalid');
                render();
              }
            },
          },
          h('h2', {}, t(lang, 'manual')),
          h('label', { for: 'f-lat' }, t(lang, 'lat')),
          latIn,
          h('label', { for: 'f-lon' }, t(lang, 'lon')),
          lonIn,
          h('button', { class: 'btn', type: 'submit' }, t(lang, 'check')),
        ),
        h('div', { id: 'fisher-map', class: 'fisher-map' }),
        h('p', { class: 'disclaimer' }, t(lang, 'disclaimer')),
      ),
    );

    map = L.map($('#fisher-map', root), { center: lastPos ?? [20, 68], zoom: lastPos ? 7 : 5, minZoom: 3 });
    addBaseLayer(map);
    addZoneLayers(map);
    if (lastPos) L.circleMarker(lastPos, { radius: 9, color: '#fff', weight: 3, fillColor: '#00b4d8', fillOpacity: 1 }).addTo(map);
  };

  const stop = (): void => {
    if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    watchId = undefined;
    map?.remove();
    map = undefined;
  };

  render();
}
