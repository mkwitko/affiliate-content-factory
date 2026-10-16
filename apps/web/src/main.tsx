import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthenticatedShell } from "./features/auth/authenticated-shell.js";
import { HomeRoute } from "./routes/index.js";
import { InvalidInvitationRoute, InvitationRoute } from "./routes/invitations.$token.js";
import { StorefrontRoute } from "./routes/n.$slug.js";
import { resolveRoute } from "./routes/route-parser.js";
import "./styles.css";

const route = (): React.ReactNode => {
  const currentRoute = resolveRoute(window.location.pathname);
  // Public bio storefront: no auth session, no dashboard chrome.
  if (currentRoute.kind === "storefront") return <StorefrontRoute slug={currentRoute.slug} />;
  const content =
    currentRoute.kind === "invitation" ? (
      <InvitationRoute token={currentRoute.token} />
    ) : currentRoute.kind === "invalid_invitation" ? (
      <InvalidInvitationRoute />
    ) : currentRoute.kind === "panel" ? (
      <HomeRoute section={currentRoute.section} />
    ) : (
      <HomeRoute />
    );
  return <AuthenticatedShell>{content}</AuthenticatedShell>;
};

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Web app root element is missing");

createRoot(rootElement).render(<StrictMode>{route()}</StrictMode>);
