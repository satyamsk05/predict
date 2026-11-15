/* Temp test: Chainlink BTC/USD aggregator on BNB Chain — settlement parity check */
const { ethers } = require('ethers');

// Chainlink BTC/USD aggregator on BSC (used by predictfun-btc-bot for PTB parity)
const CHAINLINK_BTC_USD = '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf';

const abi = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

(async () => {
  const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
  const c = new ethers.Contract(CHAINLINK_BTC_USD, abi, provider);

  const [decimals, round] = await Promise.all([
    c.decimals(),
    c.latestRoundData(),
  ]);

  const price = Number(round.answer) / 10 ** Number(decimals);
  const ageSec = Math.floor(Date.now() / 1000) - Number(round.updatedAt);
  console.log(`Chainlink BTC/USD: $${price.toFixed(2)}`);
  console.log(`roundId: ${round.roundId}`);
  console.log(`updatedAt: ${new Date(Number(round.updatedAt) * 1000).toISOString()}`);
  console.log(`age: ${ageSec}s ${ageSec < 60 ? '✅ FRESH' : ageSec < 300 ? '⚠️ OK' : '❌ STALE'}`);
})();
