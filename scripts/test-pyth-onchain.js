/* Temp test: read Pyth BTC/USD price directly from the BNB Chain contract */
const { ethers } = require('ethers');

const PYTH_BSC = '0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594';
const BTC_USD_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

const abi = [
  'function getPrice(bytes32 id) view returns (int64 price, uint64 conf, int32 expo, uint publishTime)',
  'function getPriceNoOlderThan(bytes32 id, uint256 age) view returns (int64 price, uint64 conf, int32 expo, uint publishTime)',
  'function getEmaPrice(bytes32 id) view returns (int64 price, uint64 conf, int32 expo, uint publishTime)',
];

(async () => {
  const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
  const c = new ethers.Contract(PYTH_BSC, abi, provider);

  const cases = [
    ['getPrice (latest stored)', () => c.getPrice(BTC_USD_ID)],
    ['getPriceNoOlderThan(60)', () => c.getPriceNoOlderThan(BTC_USD_ID, 60)],
    ['getPriceNoOlderThan(300)', () => c.getPriceNoOlderThan(BTC_USD_ID, 300)],
    ['getEmaPrice (latest stored)', () => c.getEmaPrice(BTC_USD_ID)],
  ];

  for (const [name, fn] of cases) {
    try {
      const r = await fn();
      const price = Number(r.price) * 10 ** Number(r.expo);
      const ageSec = Math.floor(Date.now() / 1000) - Number(r.publishTime);
      console.log(`${name}: $${price.toFixed(2)}  (published ${ageSec}s ago)`);
    } catch (e) {
      const msg = (e.reason || e.shortMessage || e.message || '').split('\n')[0];
      console.log(`${name}: ERR ${msg.slice(0, 120)}`);
    }
  }
})();
