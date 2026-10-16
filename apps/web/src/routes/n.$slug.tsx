import { NicheStorefrontRoute } from "../features/storefront/niche-storefront.js";

type StorefrontRouteProps = Readonly<{ slug: string }>;

export const StorefrontRoute = ({ slug }: StorefrontRouteProps) => (
  <NicheStorefrontRoute slug={slug} />
);
