import React, { useState } from 'react';

// Each driver lists candidate logo URLs in priority order. We try the
// first; on error fall through to the next. Final fallback is a colored
// swatch using the driver's brand color. Sources:
//   - cdn.simpleicons.org (Simple Icons, CC0) — clean monochrome marks
const SI = (slug: string, color: string) =>
  `https://cdn.simpleicons.org/${slug}/${color}`;

const SOURCES: Record<string, string[]> = {
  duckdb: [SI('duckdb', 'FFF000')],
  file: [SI('duckdb', 'FFF000')],
  snowflake: [SI('snowflake', '29B5E8')],
  databricks: [SI('databricks', 'FF3621')],
  sqlite: [SI('sqlite', '0F80CC')],
  bigquery: [SI('googlebigquery', '4285F4')],
  postgresql: [SI('postgresql', '336791')],
  redshift: [SI('amazonredshift', '8C4FFF')],
  mysql: [SI('mysql', '00758F')],
  trino: [SI('trino', 'DD00A1')],
  clickhouse: [SI('clickhouse', 'FAFF69')],
};

const FALLBACK_COLORS: Record<string, string> = {
  duckdb: '#f4bc00',
  file: '#f4bc00',
  snowflake: '#29b5e8',
  databricks: '#ff3621',
  sqlite: '#0f80cc',
  bigquery: '#4285f4',
  postgresql: '#336791',
  redshift: '#8c4fff',
  mysql: '#00758f',
  mssql: '#cc2927',
  fabric: '#117865',
  trino: '#dd00a1',
  clickhouse: '#faff69',
  athena: '#8c4fff',
};

interface DriverLogoProps {
  driver: string;
  size?: number;
  fallbackColor?: string;
}

function Swatch({ size, color }: { size: number; color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 3,
        background: color,
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

export function DriverLogo({ driver, size = 16, fallbackColor }: DriverLogoProps) {
  const sources = SOURCES[driver] ?? [];
  const swatch = fallbackColor ?? FALLBACK_COLORS[driver] ?? '#888';
  const [idx, setIdx] = useState(0);

  if (sources.length === 0 || idx >= sources.length) {
    return <Swatch size={size} color={swatch} />;
  }

  return (
    <img
      src={sources[idx]}
      alt={`${driver} logo`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setIdx(idx + 1)}
      style={{ flexShrink: 0, display: 'block', objectFit: 'contain' }}
    />
  );
}
