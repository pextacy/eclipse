/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared workspace package ships ESM + types; transpile it through Next.
  transpilePackages: ["@eclipse/shared"],
  // wagmi/viem pull in optional WalletConnect deps we don't use; keep the build
  // from failing on those optional native modules.
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
