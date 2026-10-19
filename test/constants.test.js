import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS, resolveChain, resolveToken, parseUnits, formatUnits, isValidEvmAddress, isValidSolanaAddress, DEFAULT_SOLANA_USER } from '../src/index.js';
test('all eight chain IDs, aliases and tokens resolve', () => {
  assert.equal(Object.keys(CHAINS).length, 8);
  for (const c of Object.values(CHAINS)) {
    for (const alias of [c.slug, c.chainId, ...c.aliases]) assert.equal(resolveChain(alias), c);
    for (const [symbol, token] of Object.entries(c.tokens)) {
      assert.deepEqual(resolveToken(c, symbol.toLowerCase()), token);
      assert.deepEqual(resolveToken(c, token.address), token);
    }
    assert.equal(resolveToken(c, 'native').symbol, c.nativeSymbol);
  }
  assert.throws(() => resolveChain('unknown'), /Unknown chain/);
  assert.throws(() => resolveToken('base', 'USDT'), /Unknown token/);
});
test('custom token decimals must be explicit and chain-valid', () => {
  const address = '0x1234567890123456789012345678901234567890';
  assert.throws(() => resolveToken('base', address), /Decimals/);
  assert.equal(resolveToken('base', address, 8).decimals, 8);
  assert.throws(() => resolveToken('solana', address, 8));
  assert.throws(() => resolveToken('base', address, 256));
});
test('exact units, precision, zero, negative, overflow and underflow', () => {
  assert.equal(parseUnits('1.234567', 6), 1234567n);
  assert.equal(parseUnits('0.000000000000000001', 18), 1n);
  assert.equal(parseUnits('9007199254740993', 0), 9007199254740993n);
  assert.equal(parseUnits(0.05, 18), 50000000000000000n);
  assert.equal(formatUnits(1000000n, 6), '1');
  assert.equal(formatUnits(1n, 18), '0.000000000000000001');
  assert.equal(formatUnits(-123n, 2), '-1.23');
  assert.equal(formatUnits(0n, 0), '0');
  for (const value of ['0', '-1', 'NaN', NaN, Infinity, '1e3', '.5', '1.', ' 1', '', '0.0000001', Number.MAX_SAFE_INTEGER + 1, (2n ** 256n).toString()]) assert.throws(() => parseUnits(value, 6));
  for (const d of [-1, 1.5, 256, '18']) assert.throws(() => parseUnits('1', d));
  assert.throws(() => formatUnits('1.2', 6));
  assert.equal(parseUnits((2n ** 256n - 1n).toString(), 0), 2n ** 256n - 1n);
});
test('EVM and base58 decoded-length validation', () => {
  assert.ok(isValidEvmAddress('0x1234567890123456789012345678901234567890'));
  assert.ok(!isValidEvmAddress('0x1234'));
  assert.ok(isValidSolanaAddress(DEFAULT_SOLANA_USER));
  assert.ok(isValidSolanaAddress(CHAINS.solana.tokens.USDC.address));
  assert.ok(!isValidSolanaAddress('1'.repeat(33)));
  assert.ok(!isValidSolanaAddress('0'.repeat(32)));
});
