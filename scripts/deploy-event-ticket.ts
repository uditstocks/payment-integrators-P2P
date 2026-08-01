import { ethers, network } from "hardhat";

/**
 * Deploys EventTicketCheckoutIntegrator + a SimpleERC721Client organiser.
 *
 * All addresses come from env — nothing is hardcoded (CONTRIBUTING.md).
 *
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   BASE_TX_LIMIT=200 MAX_TICKETS_PER_EVENT=4 \
 *   EVENT_ID=7 TICKET_PRICE=25 \
 *     npx hardhat run scripts/deploy-event-ticket.ts --network baseSepolia
 */
async function main() {
  const diamond = required("DIAMOND_ADDRESS");
  const usdc = required("USDC_ADDRESS");

  // USDC is 6-decimal; env values are whole USDC for readability.
  const baseTxLimit = ethers.parseUnits(process.env.BASE_TX_LIMIT ?? "200", 6);
  const maxTicketsPerEvent = BigInt(process.env.MAX_TICKETS_PER_EVENT ?? "4");
  const eventId = BigInt(process.env.EVENT_ID ?? "7");
  const ticketPrice = ethers.parseUnits(process.env.TICKET_PRICE ?? "25", 6);

  const [deployer] = await ethers.getSigners();
  console.log(`network      : ${network.name}`);
  console.log(`deployer     : ${deployer.address}`);
  console.log(`diamond      : ${diamond}`);
  console.log(`usdc         : ${usdc}`);
  console.log(`baseTxLimit  : ${ethers.formatUnits(baseTxLimit, 6)} USDC`);
  console.log(`ticket cap   : ${maxTicketsPerEvent} per user per event\n`);

  const Integrator = await ethers.getContractFactory("EventTicketCheckoutIntegrator");
  const integrator = await Integrator.deploy(diamond, usdc, baseTxLimit, maxTicketsPerEvent);
  await integrator.waitForDeployment();
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();

  const Client = await ethers.getContractFactory("SimpleERC721Client");
  const client = await Client.deploy(integratorAddr, usdc, "Event Ticket", "TCKT");
  await client.waitForDeployment();
  const clientAddr = await client.getAddress();

  await (await integrator.registerOrganiser(clientAddr)).wait();
  await (await client.setProductPrice(eventId, ticketPrice)).wait();

  console.log("── deployed ───────────────────────────────────────────");
  console.log(`integrator   : ${integratorAddr}`);
  console.log(`proxyImpl    : ${proxyImpl}   <- submit with the whitelist request`);
  console.log(`client       : ${clientAddr}`);
  console.log(`event ${eventId} priced at ${ethers.formatUnits(ticketPrice, 6)} USDC/ticket\n`);

  console.log("── verify ─────────────────────────────────────────────");
  console.log(
    `npx hardhat verify --network ${network.name} ${integratorAddr} ` +
      `${diamond} ${usdc} ${baseTxLimit} ${maxTicketsPerEvent}`
  );
  console.log(
    `npx hardhat verify --network ${network.name} ${clientAddr} ` +
      `${integratorAddr} ${usdc} "Event Ticket" "TCKT"\n`
  );

  console.log("── next ───────────────────────────────────────────────");
  console.log("Deploying does not make this live. Open a whitelist request with the");
  console.log("integrator address, proxyImpl, usdcThroughIntegrator=true, the runtime");
  console.log("bytecode hash, and the circleId(s) — see docs/WHITELISTING.md.");
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return ethers.getAddress(v);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
