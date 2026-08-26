function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Shared by every bronze writer that may target `s3://` (R2) — see
 * tao-analytics-plan.md §4.3. */
export async function configureR2Secret(connection: { run: (sql: string) => Promise<unknown> }): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const keyId = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !keyId || !secret) {
    throw new Error(
      "BRONZE_URI points at s3:// but R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are not set. " +
        "See .env.example.",
    );
  }
  await connection.run("INSTALL httpfs; LOAD httpfs;");
  await connection.run(
    // `TYPE R2` secrets auto-scope to `r2://` URIs only, not `s3://` — this
    // codebase uses `s3://` throughout (per §2's COPY example), so without an
    // explicit SCOPE the secret silently never matches and every request goes
    // out unauthenticated, surfacing as a confusing "bucket does not exist"
    // rather than a permissions error.
    `CREATE OR REPLACE SECRET r2_secret (
       TYPE R2,
       KEY_ID '${escapeSqlLiteral(keyId)}',
       SECRET '${escapeSqlLiteral(secret)}',
       ACCOUNT_ID '${escapeSqlLiteral(accountId)}',
       SCOPE 's3://'
     );`,
  );
}
