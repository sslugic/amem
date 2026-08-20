/** Public shop URL for the local UI. The seller process is not part of the CLI. */
export function shopStatus(): {
  url: string;
  enabled: boolean;
  proUrl: string;
  itUrl: string;
  proPrice: string;
  itPrice: string;
} {
  const url = (process.env.AMEM_SHOP_URL || "https://getamem.com").replace(/\/$/, "");
  const disabled = String(process.env.AMEM_SHOP_LOCAL || "").trim() === "0";
  const proCents = Number(process.env.STRIPE_AMOUNT_PRO_CENTS || 1200);
  const itCents = Number(process.env.STRIPE_AMOUNT_IT_CENTS || 4900);
  return {
    url,
    enabled: !disabled,
    proUrl: `${url}/buy/pro`,
    itUrl: `${url}/buy/it`,
    proPrice: `$${(proCents / 100).toFixed(0)}`,
    itPrice: `$${(itCents / 100).toFixed(0)}`,
  };
}
