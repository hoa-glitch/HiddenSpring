import pg from 'pg';

// Return DATE columns as 'YYYY-MM-DD' text. Otherwise a meeting on Oct 6 becomes
// midnight UTC and shows as Oct 5 in US time zones.
pg.types.setTypeParser(1082, v => v);
// Return BIGINT (file sizes, counts) as numbers instead of strings.
pg.types.setTypeParser(20, v => Number(v));

// Reused across warm Lambda invocations. Keep max small: Lambda runs one request per container.
let pool;
export function db() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}
