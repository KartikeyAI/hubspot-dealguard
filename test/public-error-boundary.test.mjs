import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, containsInternalImplementationDetail, publicErrorDetails, publicErrorMessage } from '../dist/errors.js';

test('recognises infrastructure implementation details', () => {
  for (const message of ['relation "billing_subscriptions" does not exist','PostgreSQL SQLSTATE 42P01','Neon database unavailable','Dodo Payments request failed','Cloudflare worker failure']) assert.equal(containsInternalImplementationDetail(message), true, message);
});
test('never exposes raw server errors', () => { const error=new AppError(500,'db_failure','relation "tenants" does not exist',{table:'tenants'}); assert.equal(publicErrorMessage(error),'DealGuard could not complete the request. Please try again.'); assert.equal(publicErrorDetails(error),undefined); });
test('sanitises infrastructure details even when incorrectly classified as 4xx', () => { const error=new AppError(400,'bad_request','column "dodo_subscription_id" does not exist',{provider:'dodo'}); assert.equal(publicErrorMessage(error),'DealGuard could not complete the request. Please try again.'); assert.equal(publicErrorDetails(error),undefined); });
test('keeps legitimate product validation errors', () => { const error=new AppError(400,'invalid_plan','Choose Growth or Enterprise.',{field:'tier'}); assert.equal(publicErrorMessage(error),'Choose Growth or Enterprise.'); assert.deepEqual(publicErrorDetails(error),{field:'tier'}); });
