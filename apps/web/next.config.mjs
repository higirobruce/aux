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
