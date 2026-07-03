import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  XRP_USD_FEED_ID,
  domain,
  signSettlement,
  signCommit,
  futureExpiry,
  type Settlement,
  type BatchCommit,
} from "./helpers";

const BAND_BPS = 50n; // ±0.5%
const FTSO_VALUE = 50_000_000n; // XRP/USD = 0.5 at 8 decimals (scale is irrelevant to the band)
const D6 = 1_000_000n; // 6-decimal token unit

/**
 * Deploys the full local stack: mock FXRP/USDT0, mock FTSO + fee calc wired into
 * a mock FlareContractRegistry, EclipseRegistry with a dev engine signer
 * registered, and EclipseSettlement. Mocks are permitted here (local unit tests
 * only — CLAUDE.md §2.1); the deployed demo uses real Coston2 contracts.
 */
async function deployFixture() {
  const [deployer, deskA, deskB, deskC, engine, attacker] = await ethers.getSigners();

  const ERC20 = await ethers.getContractFactory("MockERC20");
  const fxrp = await ERC20.deploy("Faucet XRP", "FXRP", 6);
  const usdt0 = await ERC20.deploy("USDT0", "USDT0", 6);

  const Ftso = await ethers.getContractFactory("MockFtsoV2");
  const ftso = await Ftso.deploy(FTSO_VALUE, 8);
  const Fee = await ethers.getContractFactory("MockFeeCalculator");
  const fee = await Fee.deploy(0);

  const Registry = await ethers.getContractFactory("MockFlareContractRegistry");
  const flareRegistry = await Registry.deploy();
  await flareRegistry.setAddress("FtsoV2", await ftso.getAddress());
  await flareRegistry.setAddress("FeeCalculator", await fee.getAddress());

  const EclipseRegistry = await ethers.getContractFactory("EclipseRegistry");
  const eclipseRegistry = await EclipseRegistry.deploy(deployer.address);

  const Settlement = await ethers.getContractFactory("EclipseSettlement");
  const settlement = await Settlement.deploy(
    await flareRegistry.getAddress(),
    await eclipseRegistry.getAddress(),
    await fxrp.getAddress(),
    await usdt0.getAddress(),
    XRP_USD_FEED_ID,
    BAND_BPS,
  );

  // Register the dev engine signer bound to a placeholder code-hash.
  const codeHash = ethers.id("dev-engine-code-hash");
  await eclipseRegistry.registerCodeHash(codeHash, engine.address);

  // Fund desks and pre-approve the settlement contract.
  for (const [desk, token, amount] of [
    [deskA, usdt0, 1_000_000n * D6],
    [deskB, fxrp, 1_000_000n * D6],
    [deskC, fxrp, 1_000_000n * D6],
  ] as const) {
    await token.mint(desk.address, amount);
    await token.connect(desk).approve(await settlement.getAddress(), amount);
  }

  const { chainId } = await ethers.provider.getNetwork();
  const dom = domain(Number(chainId), await settlement.getAddress());

  return {
    deployer, deskA, deskB, deskC, engine, attacker,
    fxrp, usdt0, ftso, fee, flareRegistry, eclipseRegistry, settlement,
    codeHash, dom,
  };
}

describe("EclipseSettlement", () => {
  describe("deposit / withdraw", () => {
    it("escrows deposits and lets idle escrow be withdrawn", async () => {
      const { settlement, fxrp, deskB } = await loadFixture(deployFixture);
      const amt = 100n * D6;
      await expect(settlement.connect(deskB).deposit(await fxrp.getAddress(), amt))
        .to.emit(settlement, "Deposited")
        .withArgs(deskB.address, await fxrp.getAddress(), amt);

      expect(await settlement.balanceOf(deskB.address, await fxrp.getAddress())).to.equal(amt);

      await expect(settlement.connect(deskB).withdraw(await fxrp.getAddress(), amt))
        .to.emit(settlement, "Withdrawn")
        .withArgs(deskB.address, await fxrp.getAddress(), amt);
      expect(await settlement.balanceOf(deskB.address, await fxrp.getAddress())).to.equal(0n);
    });

    it("blocks double-withdraw: a second withdraw of spent escrow reverts", async () => {
      const { settlement, fxrp, deskB } = await loadFixture(deployFixture);
      const amt = 100n * D6;
      await settlement.connect(deskB).deposit(await fxrp.getAddress(), amt);
      await settlement.connect(deskB).withdraw(await fxrp.getAddress(), amt);
      await expect(
        settlement.connect(deskB).withdraw(await fxrp.getAddress(), amt),
      ).to.be.revertedWithCustomError(settlement, "InsufficientEscrow");
    });

    it("rejects unsupported tokens and zero amounts", async () => {
      const { settlement, fxrp, deskA } = await loadFixture(deployFixture);
      await expect(
        settlement.connect(deskA).deposit(ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(settlement, "UnsupportedToken");
      await expect(
        settlement.connect(deskA).deposit(await fxrp.getAddress(), 0n),
      ).to.be.revertedWithCustomError(settlement, "ZeroAmount");
    });
  });

  describe("settleBatch — happy path", () => {
    it("clears a two-sided batch at a uniform FTSO-fair price and moves net balances", async () => {
      const { settlement, fxrp, usdt0, deskA, deskB, engine, dom } =
        await loadFixture(deployFixture);
      const fxrpAddr = await fxrp.getAddress();
      const usdtAddr = await usdt0.getAddress();

      // A buys 100 FXRP paying 50 USDT0; B sells 100 FXRP receiving 50 USDT0.
      await settlement.connect(deskA).deposit(usdtAddr, 50n * D6);
      await settlement.connect(deskB).deposit(fxrpAddr, 100n * D6);

      const expiry = await futureExpiry();
      const accounts = [deskA.address, deskB.address];

      const commit: BatchCommit = { batchId: 1n, accounts, expiry, nonce: 1n };
      const commitSig = await signCommit(engine, dom, commit);
      await expect(settlement.commitBatch(commit, commitSig))
        .to.emit(settlement, "BatchCommitted")
        .withArgs(1n, engine.address, 2n);

      const s: Settlement = {
        batchId: 1n,
        accounts,
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-50n * D6, 50n * D6],
        clearingPrice: FTSO_VALUE,
        ftsoRef: FTSO_VALUE,
        expiry,
        nonce: 1n,
      };
      const sig = await signSettlement(engine, dom, s);
      await expect(settlement.settleBatch(s, sig))
        .to.emit(settlement, "BatchSettled")
        .withArgs(1n, FTSO_VALUE, FTSO_VALUE, FTSO_VALUE, engine.address);

      expect(await settlement.balanceOf(deskA.address, fxrpAddr)).to.equal(100n * D6);
      expect(await settlement.balanceOf(deskA.address, usdtAddr)).to.equal(0n);
      expect(await settlement.balanceOf(deskB.address, usdtAddr)).to.equal(50n * D6);
      expect(await settlement.balanceOf(deskB.address, fxrpAddr)).to.equal(0n);

      // Legs cleared → both can withdraw their proceeds.
      await expect(settlement.connect(deskA).withdraw(fxrpAddr, 100n * D6)).to.not.be.reverted;
      await expect(settlement.connect(deskB).withdraw(usdtAddr, 50n * D6)).to.not.be.reverted;
    });
  });

  describe("settleBatch — abuse paths blocked", () => {
    async function committedBatch() {
      const ctx = await loadFixture(deployFixture);
      const fxrpAddr = await ctx.fxrp.getAddress();
      const usdtAddr = await ctx.usdt0.getAddress();
      await ctx.settlement.connect(ctx.deskA).deposit(usdtAddr, 50n * D6);
      await ctx.settlement.connect(ctx.deskB).deposit(fxrpAddr, 100n * D6);
      const expiry = await futureExpiry();
      const accounts = [ctx.deskA.address, ctx.deskB.address];
      const commit: BatchCommit = { batchId: 1n, accounts, expiry, nonce: 1n };
      await ctx.settlement.commitBatch(commit, await signCommit(ctx.engine, ctx.dom, commit));
      return { ...ctx, fxrpAddr, usdtAddr, expiry, accounts };
    }

    it("reverts UnattestedSigner when signed by a non-registered key", async () => {
      const { settlement, deskA, deskB, attacker, dom } = await committedBatch();
      const expiry = await futureExpiry();
      const s: Settlement = {
        batchId: 1n,
        accounts: [deskA.address, deskB.address],
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-50n * D6, 50n * D6],
        clearingPrice: FTSO_VALUE, ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      const sig = await signSettlement(attacker, dom, s);
      await expect(settlement.settleBatch(s, sig)).to.be.revertedWithCustomError(
        settlement, "UnattestedSigner",
      );
    });

    it("reverts PriceOutsideBand when the clearing price leaves the FTSO band", async () => {
      const { settlement, deskA, deskB, engine, dom } = await committedBatch();
      const expiry = await futureExpiry();
      const s: Settlement = {
        batchId: 1n,
        accounts: [deskA.address, deskB.address],
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-50n * D6, 50n * D6],
        clearingPrice: FTSO_VALUE * 2n, // way outside ±0.5%
        ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      await expect(
        settlement.settleBatch(s, await signSettlement(engine, dom, s)),
      ).to.be.revertedWithCustomError(settlement, "PriceOutsideBand");
    });

    it("accepts a clearing price at the band edge and rejects one just past it", async () => {
      const { settlement, deskA, deskB, engine, dom } = await committedBatch();
      const expiry = await futureExpiry();
      const edge = FTSO_VALUE + (FTSO_VALUE * BAND_BPS) / 10_000n; // exactly +0.5%
      const base = {
        batchId: 1n,
        accounts: [deskA.address, deskB.address],
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-50n * D6, 50n * D6],
        ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      const atEdge: Settlement = { ...base, clearingPrice: edge };
      await expect(settlement.settleBatch(atEdge, await signSettlement(engine, dom, atEdge)))
        .to.emit(settlement, "BatchSettled");

      // A fresh batch one wei past the edge must revert.
      const ctx2 = await committedBatch();
      const past: Settlement = {
        batchId: 1n,
        accounts: [ctx2.deskA.address, ctx2.deskB.address],
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-50n * D6, 50n * D6],
        clearingPrice: edge + 1n,
        ftsoRef: FTSO_VALUE, expiry: ctx2.expiry, nonce: 1n,
      };
      await expect(
        ctx2.settlement.settleBatch(past, await signSettlement(ctx2.engine, ctx2.dom, past)),
      ).to.be.revertedWithCustomError(ctx2.settlement, "PriceOutsideBand");
    });

    it("reverts UnbalancedBatch when net deltas do not conserve", async () => {
      const { settlement, deskA, deskB, engine, dom } = await committedBatch();
      const expiry = await futureExpiry();
      const s: Settlement = {
        batchId: 1n,
        accounts: [deskA.address, deskB.address],
        fxrpDeltas: [100n * D6, -99n * D6], // does not net to zero
        usdt0Deltas: [-50n * D6, 50n * D6],
        clearingPrice: FTSO_VALUE, ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      await expect(
        settlement.settleBatch(s, await signSettlement(engine, dom, s)),
      ).to.be.revertedWithCustomError(settlement, "UnbalancedBatch");
    });

    it("reverts ReplayedBatch when a settlement nonce is reused", async () => {
      const { settlement, deskA, deskB, engine, dom, fxrpAddr, usdtAddr, expiry } =
        await committedBatch();
      const s: Settlement = {
        batchId: 1n,
        accounts: [deskA.address, deskB.address],
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-50n * D6, 50n * D6],
        clearingPrice: FTSO_VALUE, ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      await settlement.settleBatch(s, await signSettlement(engine, dom, s));

      // Reusing nonce 1 (even in a fresh commit) must revert.
      const commit2: BatchCommit = {
        batchId: 2n, accounts: [deskA.address], expiry, nonce: 2n,
      };
      await settlement.commitBatch(commit2, await signCommit(engine, dom, commit2));
      const s2: Settlement = {
        batchId: 2n, accounts: [deskA.address],
        fxrpDeltas: [0n], usdt0Deltas: [0n],
        clearingPrice: FTSO_VALUE, ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      await expect(
        settlement.settleBatch(s2, await signSettlement(engine, dom, s2)),
      ).to.be.revertedWithCustomError(settlement, "ReplayedBatch");
      void fxrpAddr; void usdtAddr;
    });

    it("reverts InsufficientEscrow when an account cannot cover its negative leg", async () => {
      const { settlement, deskA, deskB, engine, dom, expiry } = await committedBatch();
      const s: Settlement = {
        batchId: 1n,
        accounts: [deskA.address, deskB.address],
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-500n * D6, 500n * D6], // A owes 500 USDT0 but deposited only 50
        clearingPrice: FTSO_VALUE, ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      await expect(
        settlement.settleBatch(s, await signSettlement(engine, dom, s)),
      ).to.be.revertedWithCustomError(settlement, "InsufficientEscrow");
    });

    it("reverts NotCommitted when settling an account with no open leg", async () => {
      const { settlement, deskA, deskC, engine, dom, expiry } = await committedBatch();
      // deskC was never committed into batch 1.
      const s: Settlement = {
        batchId: 1n,
        accounts: [deskA.address, deskC.address],
        fxrpDeltas: [0n, 0n], usdt0Deltas: [0n, 0n],
        clearingPrice: FTSO_VALUE, ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      await expect(
        settlement.settleBatch(s, await signSettlement(engine, dom, s)),
      ).to.be.revertedWithCustomError(settlement, "NotCommitted");
    });
  });

  describe("custody guard", () => {
    it("blocks withdrawal of escrow backing an open matched leg, but not idle escrow", async () => {
      const { settlement, fxrp, usdt0, deskA, deskB, deskC, engine, dom } =
        await loadFixture(deployFixture);
      const fxrpAddr = await fxrp.getAddress();
      const usdtAddr = await usdt0.getAddress();

      await settlement.connect(deskA).deposit(usdtAddr, 50n * D6);
      await settlement.connect(deskB).deposit(fxrpAddr, 100n * D6);
      await settlement.connect(deskC).deposit(fxrpAddr, 100n * D6); // idle, not in batch

      const expiry = await futureExpiry();
      const commit: BatchCommit = {
        batchId: 1n, accounts: [deskA.address, deskB.address], expiry, nonce: 1n,
      };
      await settlement.commitBatch(commit, await signCommit(engine, dom, commit));

      // Committed desk cannot pull its backing escrow.
      await expect(
        settlement.connect(deskA).withdraw(usdtAddr, 50n * D6),
      ).to.be.revertedWithCustomError(settlement, "OpenMatchedLeg");

      // Idle desk C can always withdraw.
      await expect(settlement.connect(deskC).withdraw(fxrpAddr, 100n * D6)).to.not.be.reverted;
    });

    it("auto-releases a leg after expiry so custody is always redeemable", async () => {
      const { settlement, usdt0, deskA, deskB, engine, dom } =
        await loadFixture(deployFixture);
      const usdtAddr = await usdt0.getAddress();
      await settlement.connect(deskA).deposit(usdtAddr, 50n * D6);

      const expiry = await futureExpiry(100);
      const commit: BatchCommit = {
        batchId: 1n, accounts: [deskA.address, deskB.address], expiry, nonce: 1n,
      };
      await settlement.commitBatch(commit, await signCommit(engine, dom, commit));

      await expect(
        settlement.connect(deskA).withdraw(usdtAddr, 50n * D6),
      ).to.be.revertedWithCustomError(settlement, "OpenMatchedLeg");

      // Engine never settled; after expiry the trader self-releases and withdraws.
      await time.increaseTo(expiry + 1n);
      await expect(settlement.connect(deskA).releaseExpiredLeg())
        .to.emit(settlement, "LegReleased")
        .withArgs(deskA.address, 1n);
      await expect(settlement.connect(deskA).withdraw(usdtAddr, 50n * D6)).to.not.be.reverted;
    });
  });

  describe("EclipseRegistry", () => {
    it("authorizes only registered signers and revokes them", async () => {
      const { eclipseRegistry, engine, attacker } = await loadFixture(deployFixture);
      expect(await eclipseRegistry.isAuthorized(engine.address)).to.equal(true);
      expect(await eclipseRegistry.isAuthorized(attacker.address)).to.equal(false);

      const codeHash = ethers.id("dev-engine-code-hash");
      await expect(eclipseRegistry.revokeCodeHash(codeHash))
        .to.emit(eclipseRegistry, "CodeHashRevoked")
        .withArgs(codeHash, engine.address);
      expect(await eclipseRegistry.isAuthorized(engine.address)).to.equal(false);
    });

    it("blocks a settlement signed by a revoked (non-whitelisted) build", async () => {
      const { settlement, eclipseRegistry, fxrp, usdt0, deskA, deskB, engine, dom } =
        await loadFixture(deployFixture);
      const fxrpAddr = await fxrp.getAddress();
      const usdtAddr = await usdt0.getAddress();
      await settlement.connect(deskA).deposit(usdtAddr, 50n * D6);
      await settlement.connect(deskB).deposit(fxrpAddr, 100n * D6);

      const expiry = await futureExpiry();
      const commit: BatchCommit = {
        batchId: 1n, accounts: [deskA.address, deskB.address], expiry, nonce: 1n,
      };
      await settlement.commitBatch(commit, await signCommit(engine, dom, commit));

      // Revoke the engine's code-hash before it settles.
      await eclipseRegistry.revokeCodeHash(ethers.id("dev-engine-code-hash"));

      const s: Settlement = {
        batchId: 1n,
        accounts: [deskA.address, deskB.address],
        fxrpDeltas: [100n * D6, -100n * D6],
        usdt0Deltas: [-50n * D6, 50n * D6],
        clearingPrice: FTSO_VALUE, ftsoRef: FTSO_VALUE, expiry, nonce: 1n,
      };
      await expect(
        settlement.settleBatch(s, await signSettlement(engine, dom, s)),
      ).to.be.revertedWithCustomError(settlement, "UnattestedSigner");
    });

    it("only owner can register / revoke", async () => {
      const { eclipseRegistry, attacker } = await loadFixture(deployFixture);
      await expect(
        eclipseRegistry.connect(attacker).registerCodeHash(ethers.id("x"), attacker.address),
      ).to.be.revertedWithCustomError(eclipseRegistry, "OwnableUnauthorizedAccount");
    });
  });
});
