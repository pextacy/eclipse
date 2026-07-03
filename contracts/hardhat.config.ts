import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const {
  COSTON2_RPC = "https://coston2-api.flare.network/ext/C/rpc",
  DEPLOYER_PRIVATE_KEY,
} = process.env;

const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/**
 * Solidity 0.8.x, EVM version **cancun** (required by Flare tooling — CLAUDE.md §3).
 * Contract tests run on the in-process Hardhat network against local mocks
 * (the only place simulation is allowed — CLAUDE.md §2.1); the deploy + demo
 * scripts target the real Coston2 network.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: "./src",
    tests: "../test/contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    coston2: {
      url: COSTON2_RPC,
      chainId: 114,
      accounts,
    },
  },
  etherscan: {
    apiKey: {
      coston2: "no-api-key-needed",
    },
    customChains: [
      {
        network: "coston2",
        chainId: 114,
        urls: {
          apiURL: "https://coston2-explorer.flare.network/api",
          browserURL: "https://coston2-explorer.flare.network",
        },
      },
    ],
  },
};

export default config;
