#!/usr/bin/env node
/**
 * Diagnostic script to verify database connectivity and schema
 * Usage: node scripts/diagnose-db-connection.mjs
 */

import pg from "pg";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const { Client } = pg;

// Read database URLs from .env
let envPath = resolve(process.cwd(), ".env");
try {
  await readFile(envPath, "utf8");
} catch {
  // Try parent directory
  envPath = resolve(process.cwd(), "..", ".env");
  try {
    await readFile(envPath, "utf8");
  } catch {
    console.error(
      "❌ .env file not found in current or parent directory",
    );
    process.exit(1);
  }
}
const envContent = await readFile(envPath, "utf8");
const envVars = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

console.log(`📄 Loaded env from: ${envPath}`);
console.log(
  `🔑 Found keys: ${Object.keys(envVars).join(", ")}\n`,
);

const databaseUrl =
  envVars.DATABASE_URL || envVars.NEON_DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "❌ DATABASE_URL or NEON_DATABASE_URL not found in .env",
  );
  console.error(
    "   Please add one of these variables to your .env file",
  );
  process.exit(1);
}

async function diagnose() {
  console.log("🔍 Diagnosing database connection...\n");

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "dealguard-diagnostic",
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // 1. Check current database and user
    const dbInfo = await client.query(
      "SELECT current_database(), current_user, inet_server_addr()",
    );
    console.log("📊 Database Info:");
    console.log(
      `   Database: ${dbInfo.rows[0].current_database}`,
    );
    console.log(`   User: ${dbInfo.rows[0].current_user}`);
    console.log(
      `   Host: ${dbInfo.rows[0].inet_server_addr}\n`,
    );

    // 2. Check if dealguard schema exists
    const schemaExists = await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'dealguard')",
    );
    console.log(
      `📁 dealguard schema exists: ${schemaExists.rows[0].exists ? "✅ YES" : "❌ NO"}\n`,
    );

    if (!schemaExists.rows[0].exists) {
      console.error(
        "❌ CRITICAL: dealguard schema does not exist!",
      );
      console.error("   Run: npm run db:migrate");
      await client.end();
      process.exit(1);
    }

    // 3. Check search_path
    const searchPath = await client.query(
      "SHOW search_path",
    );
    console.log(
      `🔍 Current search_path: ${searchPath.rows[0].search_path}\n`,
    );

    // 4. Set search_path and check tables
    await client.query(
      "SET search_path TO dealguard, public",
    );
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'dealguard' ORDER BY tablename",
    );
    console.log("📋 Tables in dealguard schema:");
    tables.rows.forEach((row) =>
      console.log(`   - ${row.tablename}`),
    );
    console.log();

    // 5. Check for critical tables
    const criticalTables = [
      "tenants",
      "oauth_states",
      "schema_migrations",
    ];
    const tableNames = tables.rows.map((r) => r.tablename);
    const missingTables = criticalTables.filter(
      (t) => !tableNames.includes(t),
    );

    if (missingTables.length > 0) {
      console.error(
        `❌ MISSING CRITICAL TABLES: ${missingTables.join(", ")}`,
      );
      console.error("   Run: npm run db:migrate");
      await client.end();
      process.exit(1);
    }

    console.log("✅ All critical tables exist\n");

    // 6. Check migration status
    const migrations = await client.query(
      "SELECT version, name, applied_at FROM dealguard.schema_migrations ORDER BY version",
    );
    console.log("🗂️  Applied migrations:");
    migrations.rows.forEach((row) => {
      console.log(
        `   ${row.version}: ${row.name} (${row.applied_at})`,
      );
    });
    console.log();

    // 7. Test query on oauth_states
    try {
      await client.query(
        "SELECT COUNT(*) FROM oauth_states",
      );
      console.log("✅ Can query oauth_states table\n");
    } catch (err) {
      console.error(
        "❌ Cannot query oauth_states:",
        err.message,
      );
      await client.end();
      process.exit(1);
    }

    // 8. Test query on tenants
    try {
      await client.query("SELECT COUNT(*) FROM tenants");
      console.log("✅ Can query tenants table\n");
    } catch (err) {
      console.error(
        "❌ Cannot query tenants:",
        err.message,
      );
      await client.end();
      process.exit(1);
    }

    console.log("✅ All diagnostics passed!");
    console.log(
      "\n💡 If Worker still shows errors, the issue is likely:",
    );
    console.log(
      "   1. Hyperdrive is pointing to a different database",
    );
    console.log(
      "   2. Connection pooling issue - try restarting the Worker",
    );
    console.log(
      "   3. Schema cache - run: npm run deploy:worker:production",
    );
  } catch (error) {
    console.error("❌ Diagnostic failed:", error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

diagnose();
