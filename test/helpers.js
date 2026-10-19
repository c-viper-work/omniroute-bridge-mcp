export const USER = '0x1234567890123456789012345678901234567890';
export function mockRelay() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, payload: init.body ? JSON.parse(init.body) : undefined });
    if (!init.body) return new Response(JSON.stringify(url.includes('/balances') ? { balances: [] } : { status: 'success' }));
    const p = JSON.parse(init.body);
    return new Response(JSON.stringify({ steps: [{ id: 'deposit', action: 'Confirm', description: 'Deposit', kind: 'transaction', requestId: 'request-' + calls.length, items: [{ status: 'incomplete', data: { from: p.user, to: USER, value: '0', data: '0xabcd', chainId: p.originChainId }, check: { endpoint: '/intents/status/v2?requestId=test', method: 'GET' } }] }], details: { currencyIn: { currency: { symbol: 'USDC', decimals: 6 }, amount: p.amount, amountFormatted: '10', amountUsd: '10' }, currencyOut: { currency: { symbol: 'OUT', decimals: 6 }, amount: '9900000', minimumAmount: '9800000', amountUsd: '9.9' }, rate: '0.99', totalImpact: { percent: '-1' }, timeEstimate: 2 }, fees: { gas: { amountUsd: '0.01' }, relayer: { amountUsd: '0.02' }, app: { amountUsd: '0.03' } } }));
  };
  return { calls, fetchImpl };
}
