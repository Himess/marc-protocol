import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";

import "./tasks/accounts";
import "./tasks/decrypt-balance";

dotenv.config();

const MNEMONIC: string = vars.get("MNEMONIC", "test test test test test test test test test test test junk");
const PRIVATE_KEY: string = process.env.PRIVATE_KEY || "";
const SEPOLIA_RPC_URL: string = process.env.SEPOLIA_RPC_URL || "https://sepolia.infura.io/v3/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const MAINNET_RPC_URL: string = process.env.MAINNET_RPC_URL || "";
const BASE_RPC_URL: string = process.env.BASE_RPC_URL || "";
const ARBITRUM_RPC_URL: string = process.env.ARBITRUM_RPC_URL || "";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: 0,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || vars.get("ETHERSCAN_API_KEY", ""),
  },
  networks: {
    hardhat: {
      accounts: {
        mnemonic: MNEMONIC,
      },
      chainId: 31337,
    },
    sepolia: {
      accounts: PRIVATE_KEY
        ? [PRIVATE_KEY]
        : {
            mnemonic: MNEMONIC,
            path: "m/44'/60'/0'/0/",
            count: 10,
          },
      chainId: 11155111,
      url: SEPOLIA_RPC_URL,
    },
    mainnet: {
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 1,
      url: MAINNET_RPC_URL,
    },
    base: {
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 8453,
      url: BASE_RPC_URL,
    },
    arbitrum: {
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 42161,
      url: ARBITRUM_RPC_URL,
    },
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.27",
    settings: {
      metadata: {
        bytecodeHash: "none",
      },
      optimizer: {
        enabled: true,
        runs: 500,
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  mocha: {
    timeout: 600_000, // 10 min — needed for real FHE ops on Sepolia
  },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
};

export default config;
