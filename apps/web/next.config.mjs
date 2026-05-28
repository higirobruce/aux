/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@aux/audio-engine',
    '@aux/design-system',
    '@aux/session-doc',
    '@aux/shared',
    '@aux/ui',
  ],
  // Proxy /api/* to the NestJS service so cookies are scoped to this origin
  // (the browser sees everything as localhost:3100).
  async rewrites() {
    const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
    return [
      {
        source: '/api/:path*',
        destination: `${api}/api/:path*`,
      },
    ];
  },
  // SharedArrayBuffer requires these headers (per docs/implementation.html §16.07).
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};

export default nextConfig;
