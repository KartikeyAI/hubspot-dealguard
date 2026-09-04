import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('migration 0014 owns the tenant-safe notification route key and 0022 does not recreate it', () => {
  const migration0014 = read('database/migrations/0014_neon_tigris_queues.sql');
  const migration0022 = read('database/migrations/0022_recommendation_delivery_slo_alerts.sql');

  assert.match(
    migration0014,
    /ALTER TABLE notification_routes ADD CONSTRAINT uq_notification_routes_portal_id UNIQUE \(portal_id, id\)/,
  );
  assert.doesNotMatch(
    migration0022,
    /ADD CONSTRAINT uq_notification_routes_portal_id UNIQUE \(portal_id, id\)/,
  );
  assert.match(
    migration0022,
    /FOREIGN KEY \(portal_id, notification_route_id\)[\s\S]*REFERENCES notification_routes\(portal_id, id\)/,
  );
});

test('active-incident trigger lookup is independent of the caller search path', () => {
  const migration0022 = read('database/migrations/0022_recommendation_delivery_slo_alerts.sql');

  assert.match(
    migration0022,
    /FROM dealguard\.recommendation_delivery_slo_incidents incident/,
  );
  assert.doesNotMatch(
    migration0022,
    /FROM recommendation_delivery_slo_incidents incident/,
  );
});
