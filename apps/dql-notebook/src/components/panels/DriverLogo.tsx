import React from 'react';
import {
  Bird, ChartColumn, Cloud, Columns3, Database, Feather, FileSpreadsheet, Layers, Rabbit, Search, Snowflake, Warehouse,
  type LucideIcon,
} from 'lucide-react';

// Each driver's mark is drawn here, from the app's own icon set, in the
// driver's colour: nothing is fetched from another site (a page that loads an
// image from a logo service tells that service who opened DQL, and when). The
// driver's name is always written beside it, so the mark is decorative.
const MARKS: Record<string, LucideIcon> = {
  duckdb: Bird,
  file: FileSpreadsheet,
  snowflake: Snowflake,
  databricks: Layers,
  sqlite: Feather,
  bigquery: Search,
  postgresql: Database,
  redshift: Warehouse,
  mysql: Database,
  mssql: Database,
  fabric: Columns3,
  trino: Rabbit,
  clickhouse: ChartColumn,
  athena: Cloud,
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
  const color = fallbackColor ?? FALLBACK_COLORS[driver] ?? '#888';
  const Mark = MARKS[driver];
  if (!Mark) return <Swatch size={size} color={color} />;
  return (
    <span
      aria-hidden
      data-driver-mark={driver}
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        // The colour on a tint of itself, outlined so a light colour (DuckDB, ClickHouse) still reads on every theme.
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 55%, var(--border-default, #888))`,
        color: `color-mix(in srgb, ${color} 70%, var(--text-primary, #222))`,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Mark size={Math.max(10, Math.round(size * 0.68))} strokeWidth={2} aria-hidden focusable={false} />
    </span>
  );
}
