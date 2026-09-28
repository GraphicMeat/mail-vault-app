import React, { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useT, getLocale } from '../../i18n/index.js';
import { formatBytes } from '../../utils/formatBytes';
import { openInBrowser } from '../../services/billingApi';
import world from '../../assets/worldCountries.json';

// Network Activity's map: where the connections in the page's range went,
// by country. The shapes are pre-projected paths (`worldCountries.json`,
// Natural Earth 110m, public domain); the places come from the daemon's
// `net.geo`, looked up offline in the bundled DB-IP database. The map is for
// the mouse; the list beside it is the same data for the keyboard and screen
// readers, and it also holds the countries too small to draw at this scale.

const LOCAL = 'local';
const DB_IP = 'https://db-ip.com';

export function countryName(code) {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/** A fill between the empty-country tone and the accent, by log share. */
const shade = (n, max) => {
  const share = max > 1 ? Math.log1p(n) / Math.log1p(max) : 1;
  return `color-mix(in srgb, var(--mail-accent) ${Math.round(25 + 75 * share)}%, var(--mail-surface-hover))`;
};

function Details({ place, name }) {
  const t = useT();
  return (
    <>
      <div className="font-medium text-mail-text">{name}</div>
      <div className="text-mail-text-muted tabular-nums">
        {t('netActivity.map.connections', { count: place.connections })}
        {' · '}{t('netActivity.sent')} {formatBytes(place.bytesUp)}
        {' · '}{t('netActivity.received')} {formatBytes(place.bytesDown)}
      </div>
      {place.hosts?.length > 0 && (
        <div className="text-mail-text-muted truncate">{t('netActivity.map.topHosts')}: {place.hosts.join(', ')}</div>
      )}
    </>
  );
}

export function NetworkMap({ places, selected, onSelect }) {
  const t = useT();
  const [hover, setHover] = useState(null);
  const local = places.find(p => p.country === LOCAL);
  const abroad = useMemo(() => places.filter(p => p.country !== LOCAL), [places]);
  const byCode = useMemo(() => new Map(abroad.map(p => [p.country, p])), [abroad]);
  const max = abroad.reduce((m, p) => Math.max(m, p.connections), 0);
  const names = useMemo(() => new Map(abroad.map(p => [p.country, countryName(p.country)])), [abroad]);
  const pick = code => onSelect(selected === code ? '' : code);
  const active = hover && (byCode.get(hover.code) || (hover.code === LOCAL ? local : null));
  // The tooltip follows the pointer over a country.
  const follow = code => e => {
    const box = e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
    setHover({ code, x: e.clientX - box.left, y: e.clientY - box.top, w: box.width, h: box.height });
  };
  // A list row shows its details on the map's corner, for the keyboard too.
  const listHover = code => ({
    onMouseEnter: () => setHover({ code, fromList: true }),
    onMouseLeave: () => setHover(null),
    onFocus: () => setHover({ code, fromList: true }),
    onBlur: () => setHover(null),
  });

  return (
    <div className="mb-3" data-testid="net-map">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="relative rounded-lg border border-mail-border bg-mail-bg overflow-hidden" onMouseLeave={() => setHover(null)}>
          <svg
            viewBox={`0 0 ${world.width} ${world.height}`}
            className="block w-full h-auto"
            role="img"
            aria-label={t('netActivity.map.label')}
          >
            {Object.entries(world.countries).map(([code, d]) => {
              const place = byCode.get(code);
              const lit = selected === code || hover?.code === code;
              return (
                <path
                  key={code}
                  d={d}
                  data-country={code}
                  data-connections={place?.connections}
                  style={{ fill: place ? shade(place.connections, max) : 'var(--mail-surface-hover)' }}
                  stroke={lit ? 'var(--mail-text)' : 'var(--mail-bg)'}
                  strokeWidth={lit ? 1.5 : 0.5}
                  className={place ? 'cursor-pointer' : undefined}
                  onMouseEnter={place ? follow(code) : undefined}
                  onMouseMove={place ? follow(code) : undefined}
                  onClick={place ? () => pick(code) : undefined}
                />
              );
            })}
          </svg>
          {active && (
            <div
              role="tooltip"
              data-testid="net-map-tooltip"
              className="pointer-events-none absolute z-10 max-w-[16rem] rounded-md border border-mail-border bg-mail-surface px-2 py-1 text-xs shadow-lg"
              style={hover.fromList
                ? { top: 8, left: 8 }
                // Away from the pointer, toward the middle: the map clips.
                : {
                  ...(hover.y > hover.h / 2 ? { bottom: hover.h - hover.y + 12 } : { top: hover.y + 12 }),
                  ...(hover.x > hover.w / 2 ? { right: hover.w - hover.x + 12 } : { left: hover.x + 12 }),
                }}
            >
              <Details place={active} name={hover.code === LOCAL ? t('netActivity.map.localNetwork') : names.get(hover.code)} />
            </div>
          )}
        </div>

        <ul className="text-xs max-h-[18rem] overflow-y-auto space-y-0.5" aria-label={t('netActivity.map.countries')}>
          {local && (
            <li>
              <button
                type="button"
                aria-pressed={selected === LOCAL}
                onClick={() => pick(LOCAL)}
                {...listHover(LOCAL)}
                className={`w-full flex justify-between gap-2 rounded px-2 py-1 text-left hover:bg-mail-surface-hover ${selected === LOCAL ? 'bg-mail-accent-tint text-mail-text' : 'text-mail-text-muted'}`}
                data-testid="net-map-local"
              >
                <span>{t('netActivity.map.localNetwork')}</span>
                <span className="tabular-nums">{local.connections}</span>
              </button>
            </li>
          )}
          {abroad.map(p => (
            <li key={p.country}>
              <button
                type="button"
                aria-pressed={selected === p.country}
                onClick={() => pick(p.country)}
                {...listHover(p.country)}
                className={`w-full flex justify-between gap-2 rounded px-2 py-1 text-left hover:bg-mail-surface-hover ${selected === p.country ? 'bg-mail-accent-tint text-mail-text' : 'text-mail-text'}`}
                data-testid="net-map-country"
                data-country={p.country}
              >
                <span className="truncate">{names.get(p.country)}</span>
                <span className="tabular-nums text-mail-text-muted">{p.connections}</span>
              </button>
            </li>
          ))}
          {!local && abroad.length === 0 && <li className="px-2 py-1 text-mail-text-muted">{t('netActivity.map.empty')}</li>}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => openInBrowser(DB_IP).catch(() => {})}
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-mail-text-muted hover:text-mail-accent-text transition-colors"
      >
        {t('netActivity.map.attribution')}
        <ExternalLink size={10} aria-hidden="true" />
      </button>
    </div>
  );
}
