import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  // Webbläsaren pratar bara med webbservern; /api skickas vidare till API:et
  // så att sessionscookien är på samma domän.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  poweredByHeader: false,
};

export default config;
