/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Run src/instrumentation.ts at server boot so background pollers
    // (HL WS, Tree News, snapshot keepalive) start with the process —
    // previously they only booted when a route was first hit, which left
    // the terminal silently stale after a PM2 restart until someone
    // visited the site (observed: 6 days of dead feed).
    instrumentationHook: true,
  },
};

export default nextConfig;
