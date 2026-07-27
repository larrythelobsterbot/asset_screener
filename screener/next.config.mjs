/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app is nested beneath /home/muffinman, which also has a lockfile.
  // Pin tracing to this package so Next does not infer the wrong workspace
  // root and accidentally include unrelated files in the server bundle.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
