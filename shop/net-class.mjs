/**
 * Best-effort datacenter vs residential classification via curated cloud CIDRs.
 * Offline — no third-party API. Coarse prefixes; prefer false negatives over false positives
 * for “residential” (unknown ≠ datacenter for visitor counts).
 */
/** @type {{ cidr: string, provider: string }[]} */
export const CLOUD_CIDRS = Object.freeze([
  // Cloudflare
  { cidr: "103.21.244.0/22", provider: "cloudflare" },
  { cidr: "103.22.200.0/22", provider: "cloudflare" },
  { cidr: "103.31.4.0/22", provider: "cloudflare" },
  { cidr: "104.16.0.0/13", provider: "cloudflare" },
  { cidr: "104.24.0.0/14", provider: "cloudflare" },
  { cidr: "108.162.192.0/18", provider: "cloudflare" },
  { cidr: "141.101.64.0/18", provider: "cloudflare" },
  { cidr: "162.158.0.0/15", provider: "cloudflare" },
  { cidr: "172.64.0.0/13", provider: "cloudflare" },
  { cidr: "173.245.48.0/20", provider: "cloudflare" },
  { cidr: "188.114.96.0/20", provider: "cloudflare" },
  { cidr: "190.93.240.0/20", provider: "cloudflare" },
  { cidr: "197.234.240.0/22", provider: "cloudflare" },
  { cidr: "198.41.128.0/17", provider: "cloudflare" },
  // DigitalOcean
  { cidr: "104.131.0.0/16", provider: "digitalocean" },
  { cidr: "104.236.0.0/16", provider: "digitalocean" },
  { cidr: "107.170.0.0/16", provider: "digitalocean" },
  { cidr: "138.68.0.0/16", provider: "digitalocean" },
  { cidr: "139.59.0.0/16", provider: "digitalocean" },
  { cidr: "143.110.0.0/16", provider: "digitalocean" },
  { cidr: "157.230.0.0/16", provider: "digitalocean" },
  { cidr: "159.65.0.0/16", provider: "digitalocean" },
  { cidr: "159.89.0.0/16", provider: "digitalocean" },
  { cidr: "161.35.0.0/16", provider: "digitalocean" },
  { cidr: "164.90.0.0/16", provider: "digitalocean" },
  { cidr: "165.22.0.0/16", provider: "digitalocean" },
  { cidr: "167.71.0.0/16", provider: "digitalocean" },
  { cidr: "167.99.0.0/16", provider: "digitalocean" },
  { cidr: "174.138.0.0/16", provider: "digitalocean" },
  { cidr: "178.128.0.0/16", provider: "digitalocean" },
  { cidr: "188.166.0.0/16", provider: "digitalocean" },
  { cidr: "198.199.64.0/18", provider: "digitalocean" },
  { cidr: "198.211.96.0/19", provider: "digitalocean" },
  { cidr: "206.189.0.0/16", provider: "digitalocean" },
  { cidr: "209.97.0.0/16", provider: "digitalocean" },
  // OVH
  { cidr: "5.39.0.0/17", provider: "ovh" },
  { cidr: "5.135.0.0/16", provider: "ovh" },
  { cidr: "5.196.0.0/16", provider: "ovh" },
  { cidr: "37.59.0.0/16", provider: "ovh" },
  { cidr: "46.105.0.0/16", provider: "ovh" },
  { cidr: "51.38.0.0/16", provider: "ovh" },
  { cidr: "51.68.0.0/16", provider: "ovh" },
  { cidr: "51.75.0.0/16", provider: "ovh" },
  { cidr: "51.77.0.0/16", provider: "ovh" },
  { cidr: "51.79.0.0/16", provider: "ovh" },
  { cidr: "51.83.0.0/16", provider: "ovh" },
  { cidr: "51.89.0.0/16", provider: "ovh" },
  { cidr: "51.91.0.0/16", provider: "ovh" },
  { cidr: "51.178.0.0/16", provider: "ovh" },
  { cidr: "51.210.0.0/16", provider: "ovh" },
  { cidr: "51.254.0.0/15", provider: "ovh" },
  { cidr: "54.36.0.0/14", provider: "ovh" },
  { cidr: "54.37.0.0/16", provider: "ovh" },
  { cidr: "91.121.0.0/16", provider: "ovh" },
  { cidr: "92.222.0.0/16", provider: "ovh" },
  { cidr: "94.23.0.0/16", provider: "ovh" },
  { cidr: "137.74.0.0/16", provider: "ovh" },
  { cidr: "142.44.128.0/17", provider: "ovh" },
  { cidr: "144.217.0.0/16", provider: "ovh" },
  { cidr: "149.56.0.0/16", provider: "ovh" },
  { cidr: "158.69.0.0/16", provider: "ovh" },
  { cidr: "167.114.0.0/16", provider: "ovh" },
  { cidr: "192.95.0.0/16", provider: "ovh" },
  { cidr: "192.99.0.0/16", provider: "ovh" },
  { cidr: "198.27.64.0/18", provider: "ovh" },
  { cidr: "198.50.128.0/17", provider: "ovh" },
  // Hetzner
  { cidr: "5.9.0.0/16", provider: "hetzner" },
  { cidr: "78.46.0.0/15", provider: "hetzner" },
  { cidr: "88.99.0.0/16", provider: "hetzner" },
  { cidr: "95.216.0.0/16", provider: "hetzner" },
  { cidr: "116.202.0.0/16", provider: "hetzner" },
  { cidr: "116.203.0.0/16", provider: "hetzner" },
  { cidr: "128.140.0.0/17", provider: "hetzner" },
  { cidr: "135.181.0.0/16", provider: "hetzner" },
  { cidr: "136.243.0.0/16", provider: "hetzner" },
  { cidr: "138.201.0.0/16", provider: "hetzner" },
  { cidr: "144.76.0.0/16", provider: "hetzner" },
  { cidr: "148.251.0.0/16", provider: "hetzner" },
  { cidr: "159.69.0.0/16", provider: "hetzner" },
  { cidr: "162.55.0.0/16", provider: "hetzner" },
  { cidr: "167.233.0.0/16", provider: "hetzner" },
  { cidr: "168.119.0.0/16", provider: "hetzner" },
  { cidr: "176.9.0.0/16", provider: "hetzner" },
  { cidr: "178.63.0.0/16", provider: "hetzner" },
  { cidr: "188.34.128.0/17", provider: "hetzner" },
  { cidr: "213.133.96.0/19", provider: "hetzner" },
  { cidr: "213.239.192.0/18", provider: "hetzner" },
  // Linode / Akamai
  { cidr: "45.33.0.0/16", provider: "linode" },
  { cidr: "45.56.0.0/16", provider: "linode" },
  { cidr: "45.79.0.0/16", provider: "linode" },
  { cidr: "50.116.0.0/18", provider: "linode" },
  { cidr: "66.175.208.0/20", provider: "linode" },
  { cidr: "66.228.32.0/19", provider: "linode" },
  { cidr: "69.164.192.0/19", provider: "linode" },
  { cidr: "72.14.176.0/20", provider: "linode" },
  { cidr: "74.207.224.0/19", provider: "linode" },
  { cidr: "96.126.96.0/19", provider: "linode" },
  { cidr: "97.107.128.0/20", provider: "linode" },
  { cidr: "139.144.0.0/16", provider: "linode" },
  { cidr: "172.104.0.0/15", provider: "linode" },
  { cidr: "172.232.0.0/13", provider: "linode" },
  { cidr: "173.230.128.0/19", provider: "linode" },
  { cidr: "173.255.192.0/18", provider: "linode" },
  { cidr: "192.46.208.0/20", provider: "linode" },
  { cidr: "192.155.80.0/20", provider: "linode" },
  { cidr: "198.58.96.0/19", provider: "linode" },
  // Vultr
  { cidr: "45.32.0.0/16", provider: "vultr" },
  { cidr: "45.63.0.0/16", provider: "vultr" },
  { cidr: "45.76.0.0/16", provider: "vultr" },
  { cidr: "45.77.0.0/16", provider: "vultr" },
  { cidr: "66.42.0.0/16", provider: "vultr" },
  { cidr: "67.207.128.0/18", provider: "vultr" },
  { cidr: "70.34.192.0/18", provider: "vultr" },
  { cidr: "95.179.128.0/17", provider: "vultr" },
  { cidr: "108.61.0.0/16", provider: "vultr" },
  { cidr: "136.244.0.0/16", provider: "vultr" },
  { cidr: "140.82.0.0/16", provider: "vultr" },
  { cidr: "144.202.0.0/16", provider: "vultr" },
  { cidr: "149.28.0.0/16", provider: "vultr" },
  { cidr: "155.138.128.0/17", provider: "vultr" },
  { cidr: "207.148.64.0/18", provider: "vultr" },
  { cidr: "209.222.0.0/19", provider: "vultr" },
  // AWS (coarse — covers common scan sources incl. us-west-2 Boardman)
  { cidr: "3.0.0.0/8", provider: "aws" },
  { cidr: "13.32.0.0/12", provider: "aws" },
  { cidr: "13.48.0.0/12", provider: "aws" },
  { cidr: "13.64.0.0/11", provider: "aws" },
  { cidr: "13.112.0.0/12", provider: "aws" },
  { cidr: "13.208.0.0/12", provider: "aws" },
  { cidr: "13.224.0.0/12", provider: "aws" },
  { cidr: "13.248.0.0/14", provider: "aws" },
  { cidr: "15.152.0.0/13", provider: "aws" },
  { cidr: "15.160.0.0/11", provider: "aws" },
  { cidr: "15.200.0.0/13", provider: "aws" },
  { cidr: "18.0.0.0/8", provider: "aws" },
  { cidr: "23.20.0.0/14", provider: "aws" },
  { cidr: "34.192.0.0/10", provider: "aws" },
  { cidr: "35.71.64.0/18", provider: "aws" },
  { cidr: "35.72.0.0/13", provider: "aws" },
  { cidr: "35.80.0.0/12", provider: "aws" },
  { cidr: "35.152.0.0/13", provider: "aws" },
  { cidr: "35.160.0.0/12", provider: "aws" },
  { cidr: "35.176.0.0/13", provider: "aws" },
  { cidr: "44.0.0.0/8", provider: "aws" },
  { cidr: "50.16.0.0/14", provider: "aws" },
  { cidr: "52.0.0.0/10", provider: "aws" },
  { cidr: "54.64.0.0/10", provider: "aws" },
  { cidr: "54.144.0.0/12", provider: "aws" },
  { cidr: "54.160.0.0/11", provider: "aws" },
  { cidr: "54.192.0.0/12", provider: "aws" },
  { cidr: "54.208.0.0/13", provider: "aws" },
  { cidr: "54.216.0.0/14", provider: "aws" },
  { cidr: "54.220.0.0/15", provider: "aws" },
  { cidr: "54.224.0.0/11", provider: "aws" },
  { cidr: "99.77.0.0/16", provider: "aws" },
  { cidr: "99.78.0.0/15", provider: "aws" },
  { cidr: "99.80.0.0/12", provider: "aws" },
  // GCP
  { cidr: "34.0.0.0/15", provider: "gcp" },
  { cidr: "34.2.0.0/16", provider: "gcp" },
  { cidr: "34.3.0.0/23", provider: "gcp" },
  { cidr: "34.4.0.0/14", provider: "gcp" },
  { cidr: "34.8.0.0/13", provider: "gcp" },
  { cidr: "34.16.0.0/12", provider: "gcp" },
  { cidr: "34.32.0.0/11", provider: "gcp" },
  { cidr: "34.64.0.0/11", provider: "gcp" },
  { cidr: "34.96.0.0/12", provider: "gcp" },
  { cidr: "34.112.0.0/13", provider: "gcp" },
  { cidr: "34.120.0.0/13", provider: "gcp" },
  { cidr: "34.128.0.0/12", provider: "gcp" },
  { cidr: "34.144.0.0/13", provider: "gcp" },
  { cidr: "34.152.0.0/13", provider: "gcp" },
  { cidr: "34.160.0.0/13", provider: "gcp" },
  { cidr: "34.168.0.0/13", provider: "gcp" },
  { cidr: "34.176.0.0/12", provider: "gcp" },
  { cidr: "35.184.0.0/13", provider: "gcp" },
  { cidr: "35.192.0.0/12", provider: "gcp" },
  { cidr: "35.208.0.0/12", provider: "gcp" },
  { cidr: "35.224.0.0/12", provider: "gcp" },
  { cidr: "35.240.0.0/13", provider: "gcp" },
  // Azure (coarse)
  { cidr: "13.64.0.0/11", provider: "azure" },
  { cidr: "20.0.0.0/11", provider: "azure" },
  { cidr: "20.33.0.0/16", provider: "azure" },
  { cidr: "20.36.0.0/14", provider: "azure" },
  { cidr: "20.40.0.0/13", provider: "azure" },
  { cidr: "20.48.0.0/12", provider: "azure" },
  { cidr: "20.64.0.0/10", provider: "azure" },
  { cidr: "20.128.0.0/11", provider: "azure" },
  { cidr: "20.160.0.0/12", provider: "azure" },
  { cidr: "20.184.0.0/13", provider: "azure" },
  { cidr: "20.192.0.0/10", provider: "azure" },
  { cidr: "40.64.0.0/10", provider: "azure" },
  { cidr: "52.224.0.0/11", provider: "azure" },
]);

function ipv4ToInt(ip) {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) + x;
  }
  return n >>> 0;
}

function parseCidr(cidr) {
  const [base, bitsRaw] = String(cidr).split("/");
  const bits = Number(bitsRaw);
  const ip = ipv4ToInt(base);
  if (ip == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { network: (ip & mask) >>> 0, mask };
}

/** @type {{ network: number, mask: number, provider: string }[] | null} */
let compiled = null;

function compile() {
  if (compiled) return compiled;
  compiled = [];
  for (const row of CLOUD_CIDRS) {
    const parsed = parseCidr(row.cidr);
    if (parsed) compiled.push({ ...parsed, provider: row.provider });
  }
  return compiled;
}

/**
 * @param {string} ip
 * @returns {{ net: "datacenter" | "residential" | "unknown", provider: string }}
 */
export function classifyNetwork(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return { net: "unknown", provider: "" };
  for (const row of compile()) {
    if ((n & row.mask) >>> 0 === row.network) {
      return { net: "datacenter", provider: row.provider };
    }
  }
  // Private / loopback — treat as unknown (local shop testing).
  if (
    (n >>> 24) === 10 ||
    (n >>> 24) === 127 ||
    (n >>> 16) === 0xc0a8 ||
    ((n >>> 16) & 0xfff0) === 0xac10
  ) {
    return { net: "unknown", provider: "" };
  }
  return { net: "residential", provider: "" };
}

/** @internal */
export function _resetNetClassForTests() {
  compiled = null;
}
