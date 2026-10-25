import { expect } from "chai";
import hre from "hardhat";

const MAX_UINT256 = (2n ** 256n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DECIMALS = 18n;
const INITIAL_SUPPLY = 1_000_000n * 10n ** 18n;
const DEPOSIT_AMOUNT = 1_000n * 10n ** 18n;
const PULL_AMOUNT = 100n * 10n ** 18n;
const PULL_LIMIT = 500n * 10n ** 18n;
const NAME = "TestToken";
const SYMBOL = "TT";

describe("ERC4626Puller", () => {
  let ethers;
  let networkHelpers;

  before(async () => {
    const connection = await hre.network.create();
    ethers = connection.ethers;
    networkHelpers = connection.networkHelpers;
  });

  async function deployFixture() {
    const [owner, spender, receiver, other] = await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [NAME, SYMBOL, DECIMALS, INITIAL_SUPPLY]);
    const vault = await ethers.deployContract("ERC4626Mock", [await asset.getAddress(), "VaultTT", "vTT"]);
    const puller = await ethers.deployContract("ERC4626Puller", [await vault.getAddress()]);

    await asset.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
    await vault.connect(owner).deposit(DEPOSIT_AMOUNT, owner.address);

    return { owner, spender, receiver, other, asset, vault, puller };
  }

  describe("Deployment", () => {
    it("should configure vault and asset correctly", async () => {
      const { asset, vault, puller } = await networkHelpers.loadFixture(deployFixture);

      expect(await puller.vault()).to.equal(await vault.getAddress());
      expect(await puller.asset()).to.equal(await asset.getAddress());
    });
  });

  describe("approvePull / pullAllowance", () => {
    it("should set allowance and emit PullApproval", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await expect(
        puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT)
      )
        .to.emit(puller, "PullApproval")
        .withArgs(await asset.getAddress(), owner.address, spender.address, PULL_LIMIT);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(PULL_LIMIT);
    });

    it("should allow revoking allowance by setting limit to 0", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT);
      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, 0n);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(0n);
    });

    it("should overwrite previous allowance", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT);
      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_AMOUNT);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(PULL_AMOUNT);
    });
  });

  describe("pullFrom", () => {
    it("should pull tokens from owner to receiver and emit TokensPulled", async () => {
      const { owner, spender, receiver, asset, vault, puller } =
        await networkHelpers.loadFixture(deployFixture);

      await vault.connect(owner).approve(await puller.getAddress(), DEPOSIT_AMOUNT);
      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT);

      const receiverBalBefore = await asset.balanceOf(receiver.address);
      const ownerSharesBefore = await vault.balanceOf(owner.address);

      await expect(
        puller.connect(spender).pullFrom(await asset.getAddress(), owner.address, receiver.address, PULL_AMOUNT)
      )
        .to.emit(puller, "TokensPulled")
        .withArgs(
          await asset.getAddress(),
          owner.address,
          spender.address,
          receiver.address,
          PULL_AMOUNT
        );

      expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalBefore + PULL_AMOUNT);
      expect(await vault.balanceOf(owner.address)).to.be.lessThan(ownerSharesBefore);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(PULL_LIMIT - PULL_AMOUNT);
    });

    it("should allow owner to pull from themselves without allowance", async () => {
      const { owner, receiver, asset, vault, puller } = await networkHelpers.loadFixture(deployFixture);

      await vault.connect(owner).approve(await puller.getAddress(), DEPOSIT_AMOUNT);

      await expect(
        puller.connect(owner).pullFrom(await asset.getAddress(), owner.address, receiver.address, PULL_AMOUNT)
      )
        .to.emit(puller, "TokensPulled")
        .withArgs(
          await asset.getAddress(),
          owner.address,
          owner.address,
          receiver.address,
          PULL_AMOUNT
        );

      expect(await asset.balanceOf(receiver.address)).to.equal(PULL_AMOUNT);
    });

    it("should revert with insufficient allowance", async () => {
      const { owner, spender, receiver, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await expect(
        puller.connect(spender).pullFrom(await asset.getAddress(), owner.address, receiver.address, PULL_AMOUNT)
      ).to.be.revertedWithCustomError(puller, "InsufficientAllowance");
    });

    it("should revert with unsupported token", async () => {
      const { owner, spender, receiver, puller } = await networkHelpers.loadFixture(deployFixture);

      const fakeToken = await ethers.deployContract("ERC20Mock", ["Fake", "FK", 18n, INITIAL_SUPPLY]);

      await puller.connect(owner).approvePull(await fakeToken.getAddress(), spender.address, PULL_LIMIT);

      await expect(
        puller.connect(spender).pullFrom(await fakeToken.getAddress(), owner.address, receiver.address, PULL_AMOUNT)
      ).to.be.revertedWithCustomError(puller, "UnsupportedToken");
    });

    it("should not decrement infinite allowance", async () => {
      const { owner, spender, receiver, asset, vault, puller } =
        await networkHelpers.loadFixture(deployFixture);

      await vault.connect(owner).approve(await puller.getAddress(), DEPOSIT_AMOUNT);
      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, MAX_UINT256);

      await puller.connect(spender).pullFrom(await asset.getAddress(), owner.address, receiver.address, PULL_AMOUNT);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(MAX_UINT256);
    });
  });

  describe("maxPullable", () => {
    it("should return 0 for unsupported token", async () => {
      const { owner, puller } = await networkHelpers.loadFixture(deployFixture);

      const fakeToken = "0x0000000000000000000000000000000000000001";
      expect(await puller.maxPullable(fakeToken, owner.address, MAX_UINT256)).to.equal(0n);
    });

    it("should return the max withdraw amount capped by upTo", async () => {
      const { owner, asset, vault, puller } = await networkHelpers.loadFixture(deployFixture);

      await vault.connect(owner).approve(await puller.getAddress(), MAX_UINT256);

      const maxWithdraw = await vault.maxWithdraw(owner.address);
      const upToLarge = 999_999n * 10n ** 18n;
      const result = await puller.maxPullable(await asset.getAddress(), owner.address, upToLarge);
      expect(result).to.equal(maxWithdraw);

      const upToSmall = 10n * 10n ** 18n;
      const result2 = await puller.maxPullable(await asset.getAddress(), owner.address, upToSmall);
      expect(result2).to.equal(upToSmall);
    });

    it("caps the quote by the vault share allowance", async () => {
      const { owner, asset, vault, puller } = await networkHelpers.loadFixture(deployFixture);
      const shareAllowance = 10n * 10n ** 18n;

      await vault.connect(owner).approve(await puller.getAddress(), shareAllowance);

      const quoted = await puller.maxPullable(await asset.getAddress(), owner.address, MAX_UINT256);
      expect(quoted).to.equal(await vault.previewRedeem(shareAllowance));
    });
  });

  describe("transferPullAllowance", () => {
    it("should transfer allowance between spenders", async () => {
      const { owner, spender, other, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT);

      await puller.connect(spender).transferPullAllowance(
        await asset.getAddress(),
        owner.address,
        other.address,
        PULL_AMOUNT
      );

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(PULL_LIMIT - PULL_AMOUNT);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, other.address)
      ).to.equal(PULL_AMOUNT);
    });

    it("should emit TransferPullAllowance", async () => {
      const { owner, spender, other, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT);

      await expect(
        puller.connect(spender).transferPullAllowance(
          await asset.getAddress(),
          owner.address,
          other.address,
          PULL_AMOUNT
        )
      )
        .to.emit(puller, "TransferPullAllowance")
        .withArgs(
          await asset.getAddress(),
          owner.address,
          spender.address,
          other.address,
          PULL_AMOUNT
        );
    });

    it("should handle infinite allowance transfer", async () => {
      const { owner, spender, other, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, MAX_UINT256);

      await puller.connect(spender).transferPullAllowance(
        await asset.getAddress(),
        owner.address,
        other.address,
        MAX_UINT256
      );

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(0n);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, other.address)
      ).to.equal(MAX_UINT256);
    });

    it("should support renunciation (toSpender = address(0))", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT);

      await puller.connect(spender).transferPullAllowance(
        await asset.getAddress(),
        owner.address,
        ZERO_ADDRESS,
        PULL_AMOUNT
      );

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(PULL_LIMIT - PULL_AMOUNT);
    });

    it("should revert on self-transfer", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_LIMIT);

      await expect(
        puller.connect(spender).transferPullAllowance(
          await asset.getAddress(),
          owner.address,
          spender.address,
          PULL_AMOUNT
        )
      ).to.be.revertedWithCustomError(puller, "TransferToSelf");
    });

    it("should revert with insufficient allowance", async () => {
      const { owner, spender, other, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      await puller.connect(owner).approvePull(await asset.getAddress(), spender.address, PULL_AMOUNT);

      await expect(
        puller.connect(spender).transferPullAllowance(
          await asset.getAddress(),
          owner.address,
          other.address,
          PULL_LIMIT
        )
      ).to.be.revertedWithCustomError(puller, "InsufficientAllowance");
    });
  });

  describe("permitPull", () => {
    it("should set allowance via EIP-712 permit", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      const deadline = MAX_UINT256;

      const domain = {
        name: "TokenPuller",
        version: "1",
        chainId: 31337n,
        verifyingContract: await puller.getAddress(),
      };

      const types = {
        PullPermit: [
          { name: "token", type: "address" },
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "limit", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const value = {
        token: await asset.getAddress(),
        owner: owner.address,
        spender: spender.address,
        limit: PULL_LIMIT,
        nonce: 0n,
        deadline,
      };

      const signature = await owner.signTypedData(domain, types, value);

      await expect(
        puller.connect(spender).permitPull(
          await asset.getAddress(),
          owner.address,
          spender.address,
          PULL_LIMIT,
          deadline,
          signature
        )
      )
        .to.emit(puller, "PullApproval")
        .withArgs(await asset.getAddress(), owner.address, spender.address, PULL_LIMIT);

      expect(
        await puller.pullAllowance(await asset.getAddress(), owner.address, spender.address)
      ).to.equal(PULL_LIMIT);

      expect(await puller.nonces(owner.address)).to.equal(1n);
    });

    it("should revert with expired deadline", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      const pastDeadline = 1n;

      await expect(
        puller.connect(spender).permitPull(
          await asset.getAddress(),
          owner.address,
          spender.address,
          PULL_LIMIT,
          pastDeadline,
          "0x"
        )
      ).to.be.revertedWithCustomError(puller, "PermitExpired");
    });

    it("should revert with invalid signature", async () => {
      const { owner, spender, other, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      const deadline = MAX_UINT256;

      const domain = {
        name: "TokenPuller",
        version: "1",
        chainId: 31337n,
        verifyingContract: await puller.getAddress(),
      };

      const types = {
        PullPermit: [
          { name: "token", type: "address" },
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "limit", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const value = {
        token: await asset.getAddress(),
        owner: owner.address,
        spender: spender.address,
        limit: PULL_LIMIT,
        nonce: 0n,
        deadline,
      };

      const signature = await other.signTypedData(domain, types, value);

      await expect(
        puller.connect(spender).permitPull(
          await asset.getAddress(),
          owner.address,
          spender.address,
          PULL_LIMIT,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(puller, "InvalidSignature");
    });
  });

  describe("pullFromWithPermit", () => {
    it("should atomically permit and pull", async () => {
      const { owner, spender, receiver, asset, vault, puller } =
        await networkHelpers.loadFixture(deployFixture);

      await vault.connect(owner).approve(await puller.getAddress(), DEPOSIT_AMOUNT);

      const deadline = MAX_UINT256;

      const domain = {
        name: "TokenPuller",
        version: "1",
        chainId: 31337n,
        verifyingContract: await puller.getAddress(),
      };

      const types = {
        PullPermit: [
          { name: "token", type: "address" },
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "limit", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const value = {
        token: await asset.getAddress(),
        owner: owner.address,
        spender: spender.address,
        limit: PULL_AMOUNT,
        nonce: 0n,
        deadline,
      };

      const signature = await owner.signTypedData(domain, types, value);

      const receiverBalBefore = await asset.balanceOf(receiver.address);

      const tx = await puller
        .connect(spender)
        .pullFromWithPermit(
          await asset.getAddress(),
          owner.address,
          receiver.address,
          PULL_AMOUNT,
          deadline,
          signature
        );

      await expect(tx)
        .to.emit(puller, "PullApproval")
        .withArgs(await asset.getAddress(), owner.address, spender.address, PULL_AMOUNT);

      await expect(tx)
        .to.emit(puller, "TokensPulled")
        .withArgs(
          await asset.getAddress(),
          owner.address,
          spender.address,
          receiver.address,
          PULL_AMOUNT
        );

      expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalBefore + PULL_AMOUNT);
      expect(await puller.nonces(owner.address)).to.equal(1n);
    });

    it("should not revert if permit was already front-run", async () => {
      const { owner, spender, receiver, asset, vault, puller } =
        await networkHelpers.loadFixture(deployFixture);

      await vault.connect(owner).approve(await puller.getAddress(), DEPOSIT_AMOUNT);

      const deadline = MAX_UINT256;

      const domain = {
        name: "TokenPuller",
        version: "1",
        chainId: 31337n,
        verifyingContract: await puller.getAddress(),
      };

      const types = {
        PullPermit: [
          { name: "token", type: "address" },
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "limit", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const value = {
        token: await asset.getAddress(),
        owner: owner.address,
        spender: spender.address,
        limit: PULL_AMOUNT,
        nonce: 0n,
        deadline,
      };

      const signature = await owner.signTypedData(domain, types, value);

      await puller
        .connect(spender)
        .permitPull(
          await asset.getAddress(),
          owner.address,
          spender.address,
          PULL_AMOUNT,
          deadline,
          signature
        );

      await expect(
        puller
          .connect(spender)
          .pullFromWithPermit(
            await asset.getAddress(),
            owner.address,
            receiver.address,
            PULL_AMOUNT,
            deadline,
            signature
          )
      )
        .to.emit(puller, "TokensPulled")
        .withArgs(
          await asset.getAddress(),
          owner.address,
          spender.address,
          receiver.address,
          PULL_AMOUNT
        );
    });
  });

  describe("EIP-5267 / eip712Domain", () => {
    it("should return correct domain data", async () => {
      const { puller } = await networkHelpers.loadFixture(deployFixture);

      const domain = await puller.eip712Domain();
      expect(domain[0]).to.equal("0x0f"); // fields
      expect(domain[1]).to.equal("TokenPuller");
      expect(domain[2]).to.equal("1");
      expect(domain[3]).to.equal(31337n);
      expect(domain[4]).to.equal(await puller.getAddress());
      expect(domain[5]).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
    });
  });

  describe("nonces", () => {
    it("should start at 0 and increment after permit", async () => {
      const { owner, spender, asset, puller } = await networkHelpers.loadFixture(deployFixture);

      expect(await puller.nonces(owner.address)).to.equal(0n);

      const deadline = MAX_UINT256;

      const domain = {
        name: "TokenPuller",
        version: "1",
        chainId: 31337n,
        verifyingContract: await puller.getAddress(),
      };

      const types = {
        PullPermit: [
          { name: "token", type: "address" },
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "limit", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const value = {
        token: await asset.getAddress(),
        owner: owner.address,
        spender: spender.address,
        limit: PULL_LIMIT,
        nonce: 0n,
        deadline,
      };

      const signature = await owner.signTypedData(domain, types, value);

      await puller.connect(spender).permitPull(
        await asset.getAddress(),
        owner.address,
        spender.address,
        PULL_LIMIT,
        deadline,
        signature
      );

      expect(await puller.nonces(owner.address)).to.equal(1n);
    });
  });
});
