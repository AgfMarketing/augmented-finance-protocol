// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.4;

import '../dependencies/openzeppelin/contracts/SafeMath.sol';
import '../access/interfaces/IMarketAccessController.sol';
import '../interfaces/IRewardMinter.sol';
import './BaseRewardController.sol';

abstract contract BasicRewardController is BaseRewardController {
  constructor(IMarketAccessController accessController, IRewardMinter rewardMinter)
    BaseRewardController(accessController, rewardMinter)
  {}

  function internalClaimAndMintReward(address holder, uint256 allMask)
    internal
    override
    returns (uint256 claimableAmount, uint256 delayedAmount)
  {
    uint32 since = 0;
    uint256 amountSince = 0;
    bool incremental = false;

    for ((uint8 i, uint256 mask) = (0, 1); mask <= allMask; (i, mask) = (i + 1, mask << 1)) {
      if (mask & allMask == 0) {
        if (mask == 0) break;
        continue;
      }

      (uint256 amount_, uint32 since_, bool keepPull) = getPool(i).claimRewardFor(holder, type(uint256).max);
      if (!keepPull) {
        internalUnsetPull(holder, mask);
      }

      if (amount_ == 0) {
        continue;
      }

      if (since == since_) {
        amountSince += amount_;
        continue;
      }

      if (amountSince > 0) {
        (uint256 ca, uint256 da) = internalClaimByCall(holder, amountSince, since);
        claimableAmount += ca;
        delayedAmount += da;
        incremental = true;
      }
      amountSince = amount_;
      since = since_;
    }

    if (amountSince > 0 || !incremental) {
      (uint256 ca, uint256 da) = internalClaimByCall(holder, amountSince, since);
      claimableAmount += ca;
      delayedAmount += da;
    }

    return (claimableAmount, delayedAmount);
  }

  function internalCalcClaimableReward(
    address holder,
    uint256 mask,
    uint32 at
  ) internal view override returns (uint256 claimableAmount, uint256 delayedAmount) {
    uint32 since = 0;
    uint256 amountSince = 0;
    bool incremental = false;

    for (uint256 i = 0; mask != 0; (i, mask) = (i + 1, mask >> 1)) {
      if (mask & 1 == 0) {
        continue;
      }

      (uint256 amount_, uint256 extra_, uint32 since_) = getPool(i).calcRewardFor(holder, at);
      delayedAmount += extra_;
      if (amount_ == 0) {
        continue;
      }

      if (since == since_) {
        amountSince += amount_;
        continue;
      }

      if (amountSince > 0) {
        (uint256 ca, uint256 da) = internalCalcByCall(holder, amountSince, since, incremental);
        claimableAmount += ca;
        delayedAmount += da;
        incremental = true;
      }
      amountSince = amount_;
      since = since_;
    }

    if (amountSince > 0 || !incremental) {
      (uint256 ca, uint256 da) = internalCalcByCall(holder, amountSince, since, incremental);
      claimableAmount += ca;
      delayedAmount += da;
    }

    return (claimableAmount, delayedAmount);
  }

  function internalClaimByCall(
    address holder,
    uint256 allocated,
    uint32 since
  ) internal virtual returns (uint256 claimableAmount, uint256 delayedAmount);

  function internalCalcByCall(
    address holder,
    uint256 allocated,
    uint32 since,
    bool incremental
  ) internal view virtual returns (uint256 claimableAmount, uint256 delayedAmount);
}
