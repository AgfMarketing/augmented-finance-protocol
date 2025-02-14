import { BigNumber } from '@ethersproject/bignumber';
import { subtask, types } from 'hardhat/config';
import { AccessFlags } from '../../helpers/access-flags';
import { DAY, RAY, USD_ADDRESS, ZERO_ADDRESS } from '../../helpers/constants';
import {
  getIErc20Detailed,
  getMarketAddressController,
  getOracleRouter,
  getProtocolDataProvider,
  getRewardConfiguratorProxy,
} from '../../helpers/contracts-getters';
import { falsyOrZeroAddress } from '../../helpers/misc-utils';
import { tEthereumAddress } from '../../helpers/types';

enum TokenType {
  PoolAsset,
  Deposit,
  VariableDebt,
  StableDebt,
  Stake,
  Reward,
  RewardStake,
}

subtask('helper:calc-apy', 'Calculates current APYs')
  .addParam('ctl', 'Address of MarketAddressController', ZERO_ADDRESS, types.string)
  .addParam('user', 'User address to calc APY', ZERO_ADDRESS, types.string)
  .addFlag('quiet')
  .setAction(async ({ ctl, user: userAddr, quiet }, DRE) => {
    if (falsyOrZeroAddress(ctl)) {
      throw new Error('Unknown MarketAddressController');
    }
    if (falsyOrZeroAddress(userAddr)) {
      userAddr = ZERO_ADDRESS;
    }

    const ac = await getMarketAddressController(ctl);
    const dp = await getProtocolDataProvider(await ac.getAddress(AccessFlags.DATA_HELPER));

    const poolInfo = new Map<
      string,
      {
        poolName: string;
        poolRate: BigNumber;
        poolToken: string;
      }
    >();

    const priceCurrency = USD_ADDRESS;
    const priceCurrencyName = 'USD';
    const basePriceDecimals = 18; // all prices are nominated in ETH, hence decimals = 18

    const addresses = await dp.getAddresses();

    if (!quiet) {
      console.log('Access Controller:', ac.address);
      console.log('Data Helper:', dp.address);
      console.log('Addresses:', addresses);
    }

    {
      const rw = await getRewardConfiguratorProxy(addresses.rewardConfigurator);

      const poolList: string[] = [];
      for (const poolAddr of await rw.list()) {
        if (!falsyOrZeroAddress(poolAddr)) {
          poolList.push(poolAddr);
        }
      }
      const poolParams = await rw.getPoolParams(poolList);
      for (let i = 0; i < poolList.length; i++) {
        poolInfo.set(poolList[i].toLowerCase(), {
          poolName: '',
          poolRate: poolParams.rates[i],
          poolToken: '',
        });
      }
      console.log('Found', poolInfo.size, 'pool(s)');
    }

    const tokenInfo = new Map<
      string,
      {
        token: string;
        priceToken: string;
        rewardPool: string;
        tokenSymbol: string;
        underlying: string;
        decimals: number;
        tokenType: number;
        active: boolean;
        frozen: boolean;
        totalSupply: BigNumber;
      }
    >();

    const priceInfo = new Map<
      string,
      {
        tokenName: string;
        decimals: number;
        price: BigNumber;
      }
    >();

    const tokenAddrList: tEthereumAddress[] = [];
    const tokenTypeList: number[] = [];

    {
      const requests: Promise<void>[] = [];

      const descs = await dp.getAllTokenDescriptions(true);
      for (let i = descs.tokenCount.toNumber(); i > 0; i--) {
        let token = { ...descs.tokens[i - 1] };
        const key = token.token.toLowerCase();
        tokenInfo.set(key, { ...token, totalSupply: BigNumber.from(0) });
        const tokenAddr = token.token;

        tokenAddrList.push(tokenAddr);
        tokenTypeList.push(token.tokenType);

        // TODO this requires a better function of Data Provider
        requests.push(
          (async () => {
            const t = await getIErc20Detailed(tokenAddr);
            tokenInfo.get(key)!.totalSupply = await t.totalSupply();
          })()
        );

        if (!falsyOrZeroAddress(token.priceToken)) {
          priceInfo.set(token.priceToken, {
            tokenName: token.tokenSymbol,
            decimals: basePriceDecimals,
            price: BigNumber.from(0),
          });
        }

        if (!falsyOrZeroAddress(token.rewardPool)) {
          const pool = poolInfo.get(token.rewardPool.toLowerCase());
          if (pool == undefined) {
            if (token.rewardPool == token.token) {
              // this is an unconfigured self-pool
              continue;
            }
            throw new Error(`Unknown pool of ${token}`);
          }
          pool.poolName = token.tokenSymbol + 'Pool';
          pool.poolToken = key;
        }
      }
      Promise.all(requests);

      console.log('Found', tokenInfo.size, 'token(s)');
    }

    const agfToken = tokenInfo.get(addresses.rewardToken.toLowerCase())!;
    const xagfToken = tokenInfo.get(addresses.rewardStake.toLowerCase())!;

    {
      priceInfo.set(priceCurrency, {
        tokenName: priceCurrencyName,
        decimals: 8,
        price: BigNumber.from(0),
      });

      console.log('Required', priceInfo.size, 'price(s)');

      const po = await getOracleRouter(addresses.priceOracle);
      const priceList: string[] = [];
      priceInfo.forEach((value, key: string) => {
        priceList.push(key);
      });

      let allPrices = true;
      try {
        const prices = await po.getAssetsPrices(priceList);
        for (let i = 0; i < priceList.length; i++) {
          priceInfo.get(priceList[i])!.price = prices[i];
        }
      } catch {
        allPrices = false;
        for (let i = 0; i < priceList.length; i++) {
          const pi = priceInfo.get(priceList[i])!;
          try {
            pi.price = await po.getAssetPrice(priceList[i]);
          } catch {
            console.log('Failed to get a price:', pi.tokenName, priceList[i]);
          }
        }
      }
      if (allPrices) {
        console.log('Found all prices');
      }
    }

    if (!quiet) {
      const { 0: reserves, 1: userReserves, 2: usdPrice } = await dp.getReservesData(ZERO_ADDRESS);

      console.log('\nLending pools:');
      for (let i = 0; i < reserves.length; i++) {
        const reserve = reserves[i];
        console.log(
          reserve.symbol,
          reserve.decimals.toNumber(),
          `\tDeposit: ${formatFixed(reserve.liquidityRate, 27 - 2, 4)}%`,
          `\tVariable: ${formatFixed(reserve.variableBorrowRate, 27 - 2, 4)}%`,
          `\tStable: ${formatFixed(reserve.stableBorrowRate, 27 - 2, 4)}%`,
          `\tLiquidity: ${formatFixed(reserve.availableLiquidity, reserve.decimals.toNumber(), 6)}`,
          `\tDebt: ${formatFixed(
            reserve.totalScaledVariableDebt.mul(reserve.variableBorrowIndex).div(RAY),
            reserve.decimals.toNumber(),
            6
          )}`
        );
      }
    }

    const agfPrice = priceInfo.get(agfToken.priceToken)!;
    {
      console.log('\nRewards and boosts');

      let totalValue = BigNumber.from(0);
      let totalRate = BigNumber.from(0);
      let boostRate = BigNumber.from(0);
      const totalDecimals = basePriceDecimals;
      const totalExp = powerOf10(totalDecimals);

      const xagfAddr = xagfToken.token.toLowerCase();

      poolInfo.forEach((value, key) => {
        if (value.poolToken === '') {
          // ignore special pools
          return;
        }

        const annualRate = perAnnum(value.poolRate);
        totalRate = totalRate.add(annualRate);
        if (value.poolToken == xagfAddr) {
          boostRate = boostRate.add(annualRate);
          return;
        }
        const token = tokenInfo.get(value.poolToken)!;

        if (token.totalSupply.eq(0)) {
          console.log(
            '\t',
            value.poolName,
            '\t',
            formatFixed(annualRate, agfToken.decimals, 4),
            'AGF p.a.;\tReward APY:\tINF %'
          );
          return;
        }

        const tokenPrice = priceInfo.get(token.priceToken)!;
        if (tokenPrice == undefined) {
          console.log('\t', value.poolName, 'unknown price', token.priceToken);
          return;
        }

        const tokenValue = token.totalSupply.mul(tokenPrice.price);
        const tokenValueDecimals = token.decimals + tokenPrice.decimals;
        totalValue = totalValue.add(tokenValue.mul(totalExp).div(powerOf10(tokenValueDecimals)));

        console.log(
          '\t',
          value.poolName,
          '\t',
          formatFixed(annualRate, agfToken.decimals, 4),
          'AGF p.a.;\tReward APY:\t',
          tokenValue.eq(0)
            ? 'INF'
            : formatFixed(
                annualRate
                  .mul(agfPrice.price)
                  .mul(10 ** 4) // keep precision for 4 digits => 100.00%
                  .div(tokenValue),
                agfToken.decimals + agfPrice.decimals + 4 - tokenValueDecimals - 2,
                2
              ),
          '%'
        );
      });

      const maxBoostAPY = (v: BigNumber) =>
        totalValue.eq(0)
          ? 'INF'
          : formatFixed(
              v
                .mul(agfPrice.price)
                .mul(10 ** 4) // keep precision for 4 digits => 100.00%
                .div(totalValue),
              agfToken.decimals + agfPrice.decimals + 4 - totalDecimals - 2,
              2
            );
      console.log(
        '\n\tAvg Max APY',
        formatFixed(totalRate, agfToken.decimals, 4),
        'AGF p.a.;\tAPY%:\t',
        maxBoostAPY(totalRate),
        '%'
      );
      console.log(
        '\tAvg Boost APY',
        formatFixed(boostRate, agfToken.decimals, 4),
        'AGF p.a.;\tAPY%:\t',
        maxBoostAPY(boostRate),
        '%'
      );
    }

    if (!falsyOrZeroAddress(userAddr)) {
      console.log('\nBalances of user:', userAddr);

      const currencyPrice = priceInfo.get(priceCurrency)!;
      console.log('\t ETH', '\t@', formatFixed(currencyPrice.price, currencyPrice.decimals, 6), priceCurrencyName);

      const rewardedBalanceValues = new Map<string, BigNumber>();

      let totalValue = BigNumber.from(0);
      const totalDecimals = basePriceDecimals;
      const totalExp = powerOf10(totalDecimals);

      {
        // TODO use rewardedBalanceOf() for pool and stake tokens
        const allBalances = await dp.batchBalanceOf([userAddr], tokenAddrList, tokenTypeList, 0);

        for (let i = allBalances.length; i > 0; i--) {
          const tokenBalances = allBalances[i - 1];
          if (tokenBalances.rewardedBalance.eq(0)) {
            continue;
          }

          const tokenKey = tokenAddrList[i - 1].toLowerCase();
          const token = tokenInfo.get(tokenKey)!;
          const balanceV = formatFixed(tokenBalances.rewardedBalance, token.decimals, 4);
          if (falsyOrZeroAddress(token.priceToken)) {
            console.log('\t', token.tokenSymbol, '\t', balanceV);
            continue;
          }
          const price = priceInfo.get(token.priceToken)!;
          const balanceValue = tokenBalances.rewardedBalance.mul(price.price);
          rewardedBalanceValues.set(tokenKey, balanceValue);
          totalValue = totalValue.add(balanceValue.mul(totalExp).div(powerOf10(price.decimals + token.decimals)));

          const priceV = formatFixed(
            price.price.mul(currencyPrice.price).div(BigNumber.from(10).pow(currencyPrice.decimals)),
            price.decimals,
            6
          );
          const totalV = formatFixed(
            balanceValue.mul(currencyPrice.price),
            token.decimals + price.decimals + currencyPrice.decimals,
            4
          );
          console.log('\t', token.tokenSymbol, '\t', balanceV, '\t;\t', totalV, '\t@', priceV, priceCurrencyName);
        }
      }

      console.log('\nRewards of user:', userAddr);
      const { 0: explained, 1: explainedAt } = await dp.explainReward(userAddr, 10);
      console.log(
        '\tClaimable:',
        formatFixed(explained.amountClaimable, agfToken.decimals, 4),
        '\tExtra:',
        formatFixed(explained.amountExtra, agfToken.decimals, 4),
        '\tBoostLimit:',
        formatFixed(explained.boostLimit, agfToken.decimals, 4),
        '\tMaxBoost:',
        formatFixed(explained.maxBoost, agfToken.decimals, 4),
        '\tContributing Pools:',
        explained.allocations.length
      );

      const [boostAlloc, boostMax] = explained.boostLimit.gt(explained.maxBoost)
        ? [explained.maxBoost, explained.boostLimit]
        : [explained.boostLimit, explained.maxBoost];

      const boostDifference = boostAlloc.eq(0)
        ? boostMax.mul(0)
        : boostMax
            .mul(10 ** 4)
            .div(boostAlloc)
            .toNumber() /
          10 ** 2;

      const adviceTolerance = 120; // %
      if (boostDifference > adviceTolerance) {
        if (explained.boostLimit.gt(boostAlloc)) {
          console.log('\n\tGet upto', boostDifference, '% more boost rewards by locking AGF\n');
        } else if (explained.maxBoost.gt(boostAlloc)) {
          console.log(
            '\n\tGet upto',
            boostDifference,
            '% more boost rewards by making more deposits, borrows or stakes\n'
          );
        }
      }

      console.log('\tRewards by pools:');
      for (const poolAlloc of explained.allocations) {
        const pool = poolInfo.get(poolAlloc.pool.toLowerCase())!;
        const duration = explainedAt - poolAlloc.since;
        const allocRate = perAnnum(poolAlloc.amount).div(duration);
        const tokenKey = pool.poolToken.toLowerCase();

        if (poolAlloc.rewardType == 1 /* BoostReward */) {
          continue;
        }

        const token = tokenInfo.get(tokenKey)!;
        const tokenPrice = priceInfo.get(token.priceToken)!;
        const balanceValue = rewardedBalanceValues.get(tokenKey)!;
        if (balanceValue == undefined || balanceValue!.eq(0)) {
          continue;
        }

        console.log(
          '\t',
          pool.poolName,
          '\tBoost Factor:',
          poolAlloc.factor / 10 ** 2,
          '%\tType:',
          poolAlloc.rewardType,
          '\tReward APY:',
          formatFixed(
            allocRate
              .mul(agfPrice.price)
              .mul(10 ** 4) // keep precision for 4 digits => 100.00%
              .div(balanceValue),
            agfToken.decimals + agfPrice.decimals + 4 - (token.decimals + tokenPrice.decimals) - 2,
            2
          ),
          '%'
        );
      }

      const boostDuration = explainedAt - explained.latestClaimAt;
      if (boostDuration > 0 && totalValue.gt(0)) {
        const formatBoostAPY = (v: BigNumber) =>
          formatFixed(
            perAnnum(v)
              .mul(agfPrice.price)
              .mul(10 ** 4) // keep precision for 4 digits => 100.00%
              .div(totalValue)
              .div(boostDuration),
            agfToken.decimals + agfPrice.decimals + 4 - totalDecimals - 2,
            2
          );

        console.log('\tCurrent boost APY:', formatBoostAPY(boostAlloc), '%');
        console.log('\tMax boost APY:', formatBoostAPY(boostMax), '%');
      }
    }
  });

const perAnnum = (v: BigNumber) => v.mul(365 * DAY);

const formatFixed = (v: BigNumber, decimals: number, precision?: number): number => {
  const p = precision || 4;
  if (decimals <= p) {
    return parseFloat(v.toString()) / 10.0 ** decimals;
  }
  return parseFloat(v.div(powerOf10(decimals - p)).toString()) / 10.0 ** p;
};

const powerOf10 = (n: number) => BigNumber.from(10).pow(n);
