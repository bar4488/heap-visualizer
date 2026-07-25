import test from 'node:test';
import assert from 'node:assert/strict';

import { normAddr } from '../heap/addr.js';

test('normAddr: canonicalizes to lowercase 0x form', () => {
  assert.equal(normAddr('0x7fff'), '0x7fff');
  assert.equal(normAddr('0X7FFF'), '0x7fff');
  assert.equal(normAddr('7fff'), '0x7fff');
  assert.equal(normAddr('  0x7FFF  '), '0x7fff');
});

test('normAddr: strips leading zeros so equal addresses compare equal', () => {
  assert.equal(normAddr('0x0000ff'), '0xff');
  assert.equal(normAddr('0x00'), '0x0');
  // this is what makes the "already there" check in addAddrRange work
  assert.equal(normAddr('0x0000ff'), normAddr('FF'));
});

test('normAddr: rejects anything that is not a hex address', () => {
  assert.equal(normAddr(''), null);
  assert.equal(normAddr('   '), null);
  assert.equal(normAddr(null), null);
  assert.equal(normAddr(undefined), null);
  assert.equal(normAddr('0x'), null);
  assert.equal(normAddr('xyz'), null);
  assert.equal(normAddr('0xg1'), null);
  assert.equal(normAddr('12.5'), null);
  assert.equal(normAddr('-0x10'), null);
  assert.equal(normAddr('0x10 0x20'), null);
});

test('normAddr: handles addresses beyond 2^53 exactly', () => {
  // BigInt, not Number — a 64-bit address must survive the round trip
  assert.equal(normAddr('0xffffffffffffffff'), '0xffffffffffffffff');
  assert.equal(normAddr('0x7fffffffffffffff'), '0x7fffffffffffffff');
});
