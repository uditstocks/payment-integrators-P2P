import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("EventTicketCheckoutIntegrator — per-event ticket cap", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let organiser: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(200);
  const MAX_TICKETS_PER_EVENT = 4;
  const TICKET_PRICE = USDC(25);
  const EVENT_ID = 7;
  const OTHER_EVENT_ID = 8;
  const INR = ethers.encodeBytes32String("INR");

  // (client, eventId, quantity, currency, circleId, pubKey, channelCfg, fiatLimit)
  const place = (signer: SignerWithAddress, qty: number, eventId = EVENT_ID) =>
    integrator.connect(signer).userPlaceOrder(organiser.target, eventId, qty, INR, 1, "", 0, 0);

  // Lets a test invoke the integrator's Diamond-gated callbacks directly, for
  // branches MockDiamond's own guards make unreachable.
  const impersonateDiamond = async () => {
    const addr = await mockDiamond.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [addr]);
    await ethers.provider.send("hardhat_setBalance", [addr, "0xde0b6b3a7640000"]);
    return ethers.getSigner(addr);
  };

  beforeEach(async function () {
    [owner, user, user2] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("EventTicketCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      BASE_TX_LIMIT,
      MAX_TICKETS_PER_EVENT
    );

    // The organiser is a plain ICheckoutClient — reusing the repo's reference
    // ERC721 client shows the integrator/client boundary is unchanged.
    const Client = await ethers.getContractFactory("SimpleERC721Client");
    organiser = await Client.deploy(
      await integrator.getAddress(),
      await mockUsdc.getAddress(),
      "Summer Fest Ticket",
      "FEST"
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await integrator.registerOrganiser(await organiser.getAddress());
    await organiser.setProductPrice(EVENT_ID, TICKET_PRICE);
    await organiser.setProductPrice(OTHER_EVENT_ID, TICKET_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100_000));
  });

  describe("Happy path", function () {
    it("place → complete mints the tickets to the buyer", async function () {
      await place(user, 2);
      await mockDiamond.simulateOrderComplete(1);

      expect(await organiser.balanceOf(user.address)).to.equal(2);
      expect(await organiser.ownerOf(1)).to.equal(user.address);
      expect(await organiser.ownerOf(2)).to.equal(user.address);
    });

    it("charges unitPrice × quantity and pays the organiser on completion", async function () {
      await place(user, 3);
      const order = await integrator.getOrder(1);
      expect(order.usdcAmount).to.equal(USDC(75));

      await mockDiamond.simulateOrderComplete(1);
      expect(await mockUsdc.balanceOf(await organiser.getAddress())).to.equal(USDC(75));
      expect((await integrator.getOrder(1)).fulfilled).to.equal(true);
    });

    it("places through a deterministic per-user UserProxy", async function () {
      const predicted = await integrator.proxyAddress(user.address);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      await expect(place(user, 1))
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(user.address, predicted);

      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
      // Second order reuses the same proxy — no redeploy event.
      await expect(place(user, 1)).to.not.emit(integrator, "UserProxyDeployed");
    });
  });

  describe("Per-event ticket cap", function () {
    it("allows purchases up to the cap across multiple orders", async function () {
      await place(user, 2);
      await place(user, 2);
      expect(await integrator.ticketsRemaining(user.address, organiser.target, EVENT_ID)).to.equal(
        0
      );
    });

    it("blocks the order that would cross the cap", async function () {
      await place(user, 3);
      await expect(place(user, 2)).to.be.revertedWithCustomError(integrator, "TicketCapExceeded");
    });

    it("reserves at placement — pending orders still count", async function () {
      await place(user, 4); // never completed
      expect(await integrator.ticketsRemaining(user.address, organiser.target, EVENT_ID)).to.equal(
        0
      );
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "TicketCapExceeded");
    });

    it("is scoped per event", async function () {
      await place(user, 4, EVENT_ID);
      await expect(place(user, 4, OTHER_EVENT_ID)).to.not.be.reverted;
    });

    it("is scoped per user", async function () {
      await place(user, 4);
      await expect(place(user2, 4)).to.not.be.reverted;
    });
  });

  describe("onOrderCancel releases the reservation", function () {
    it("frees the tickets and lets the user re-buy", async function () {
      await place(user, 4);
      await expect(mockDiamond.simulateOrderCancelled(1))
        .to.emit(integrator, "TicketOrderCancelled")
        .withArgs(1, user.address, organiser.target, EVENT_ID, 4);

      expect(await integrator.ticketsRemaining(user.address, organiser.target, EVENT_ID)).to.equal(
        4
      );
      await expect(place(user, 4)).to.not.be.reverted;
    });

    // MockDiamond.simulateOrderCancelled has its own `!completed` / `!cancelled`
    // guards, so these two branches are reached by calling the integrator as the
    // Diamond directly — which is also what the real gateway does (under
    // try/catch, so a revert here is swallowed protocol-side).
    it("does not free tickets for a fulfilled order", async function () {
      await place(user, 2);
      await mockDiamond.simulateOrderComplete(1);

      const asDiamond = await impersonateDiamond();
      await expect(integrator.connect(asDiamond).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyFulfilled"
      );
      expect(await integrator.ticketsRemaining(user.address, organiser.target, EVENT_ID)).to.equal(
        2
      );
    });

    it("does not double-release on a repeated cancel", async function () {
      await place(user, 2);
      await mockDiamond.simulateOrderCancelled(1);

      const asDiamond = await impersonateDiamond();
      await expect(integrator.connect(asDiamond).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyCancelled"
      );
      expect(await integrator.ticketsRemaining(user.address, organiser.target, EVENT_ID)).to.equal(
        4
      );
    });

    it("tolerates an unknown orderId without reverting", async function () {
      const asDiamond = await impersonateDiamond();
      await expect(integrator.connect(asDiamond).onOrderCancel(999)).to.not.be.reverted;
    });
  });

  describe("Per-tx USDC limit", function () {
    it("rejects an order above baseTxLimit", async function () {
      await integrator.setMaxTicketsPerEvent(100);
      // 9 × 25 = 225 USDC > 200 limit
      await expect(place(user, 9)).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");
    });

    it("validateOrder mirrors the limit for the Diamond", async function () {
      // Called through the mock gateway during placement; a direct call from a
      // non-Diamond caller must be rejected.
      await expect(
        integrator.connect(user).validateOrder(user.address, USDC(10), INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("Access control + input validation", function () {
    it("rejects an unregistered organiser", async function () {
      await integrator.removeOrganiser(organiser.target);
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "ClientNotRegistered");
    });

    it("rejects an unpriced event", async function () {
      await expect(place(user, 1, 999)).to.be.revertedWithCustomError(integrator, "EventNotFound");
    });

    it("rejects quantity = 0", async function () {
      await expect(place(user, 0)).to.be.revertedWithCustomError(integrator, "InvalidQuantity");
    });

    it("gates onOrderComplete on the Diamond", async function () {
      await place(user, 1);
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, TICKET_PRICE, user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("gates onOrderCancel on the Diamond", async function () {
      await place(user, 1);
      await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("gates admin setters on the owner", async function () {
      await expect(integrator.connect(user).setBaseTxLimit(USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(integrator.connect(user).setMaxTicketsPerEvent(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(
        integrator.connect(user).registerOrganiser(user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(user).removeOrganiser(user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("rejects a zero-address organiser and a zero cap", async function () {
      await expect(integrator.registerOrganiser(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAddress"
      );
      await expect(integrator.setMaxTicketsPerEvent(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidCap"
      );
    });

    it("validates constructor arguments", async function () {
      const Integrator = await ethers.getContractFactory("EventTicketCheckoutIntegrator");
      await expect(
        Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), BASE_TX_LIMIT, 4)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        Integrator.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress, BASE_TX_LIMIT, 4)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          BASE_TX_LIMIT,
          0
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidCap");
    });
  });

  describe("Completion replay", function () {
    it("cannot be fulfilled twice", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderComplete(1);
      await expect(mockDiamond.simulateOrderComplete(1)).to.be.reverted;
      expect(await organiser.balanceOf(user.address)).to.equal(1);
    });

    it("rejects an unknown orderId", async function () {
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          424242,
          user.address,
          TICKET_PRICE,
          await integrator.getAddress()
        )
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
    });

    it("rejects completion of a cancelled order", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderCancelled(1);
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          1,
          user.address,
          TICKET_PRICE,
          await integrator.getAddress()
        )
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyCancelled");
    });
  });
});
